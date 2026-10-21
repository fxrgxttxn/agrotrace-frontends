"""
Refresh tokens (R32, R40, P12), the port of backend-express/src/modules/auth/sessions.ts: an opaque token (32 random
bytes, base64url) in the `at_refresh` cookie, stored as its sha256 hex in the shared `refresh_tokens` table, 14 days.
Every refresh rotates: the presented row gets `revoked_at` and `replaced_by` = the new row, so the rows of one session
form a chain (a session begun on Express continues here and vice versa). A row revoked with `replaced_by` = null was
revoked by logout, a password reset, a block, a 403 on refresh or a chain revocation — never by rotation.

The `Set-Cookie` lines are written verbatim (never `response.set_cookie`, which adds `expires`), byte for byte the
lines of Express.

P12: every transaction that revokes or rotates refresh tokens of a user takes
`pg_advisory_xact_lock(hashtext('refresh:' || user_id))` FIRST; only then rows are locked `FOR NO KEY UPDATE`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from agrotrace.core import sql
from agrotrace.core.patterns import ecma
from agrotrace.core.tx import Tx, with_tx
from agrotrace.security.tokens import new_opaque_token, sha256hex

REFRESH_TTL_SEC = 14 * 24 * 3600
#: R32: a token rotated at most this long ago is a race between tabs, not a reuse.
ROTATION_GRACE_MS = 10_000

COOKIE_ATTRS = "Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict"
CLEAR_REFRESH_COOKIE = f"at_refresh=; Max-Age=0; {COOKIE_ATTRS}"
_TOKEN = ecma(r"^[A-Za-z0-9_-]{16,256}$")


def set_refresh_cookie(token: str) -> str:
    return f"at_refresh={token}; Max-Age={REFRESH_TTL_SEC}; {COOKIE_ATTRS}"


def refresh_cookie_of(header: str | None) -> str | None:
    """The `at_refresh` value of a Cookie header (the first one), or None."""
    if not header:
        return None
    for part in header.split(";"):
        eq = part.find("=")
        if eq > 0 and part[:eq].strip() == "at_refresh":
            v = part[eq + 1:].strip()
            return v or None
    return None


def well_formed(token: str | None) -> bool:
    return token is not None and _TOKEN.search(token) is not None


def issue(user_id: str) -> str:
    """A new refresh token row for `user_id` (on the current connection — inside a transaction or autocommit);
    returns the token (only its hash is stored). `expires_at` derives from the statement's now() (P43)."""
    return _insert(user_id)[1]


def _insert(user_id: str) -> tuple[str, str]:
    token = new_opaque_token()
    row_id = sql.scalar(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) "
        "VALUES (%s, %s, now() + %s * interval '1 second') RETURNING id::text",
        [user_id, sha256hex(token), REFRESH_TTL_SEC],
    )
    return row_id, token


def lock_user_refresh(tx: Tx, user_id: str) -> None:
    tx.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ["refresh:" + user_id])


def revoke_chain(tx: Tx, row_id: str, now: datetime) -> None:
    """R40: every row linked to `row_id` through `replaced_by` — ancestors and descendants; other sessions stay."""
    tx.execute(
        """
        WITH RECURSIVE down(id, replaced_by) AS (
          SELECT id, replaced_by FROM refresh_tokens WHERE id = %s
          UNION
          SELECT r.id, r.replaced_by FROM refresh_tokens r JOIN down d ON r.id = d.replaced_by
        ), up(id) AS (
          SELECT id FROM refresh_tokens WHERE id = %s
          UNION
          SELECT r.id FROM refresh_tokens r JOIN up u ON r.replaced_by = u.id
        )
        UPDATE refresh_tokens SET revoked_at = %s
         WHERE revoked_at IS NULL AND id IN (SELECT id FROM down UNION SELECT id FROM up)
        """,
        [row_id, row_id, now],
    )


def revoke_all(tx: Tx, user_id: str, now: datetime) -> None:
    """Every live refresh token of the user (password reset, block) — under the user's advisory lock."""
    lock_user_refresh(tx, user_id)
    tx.execute("UPDATE refresh_tokens SET revoked_at = %s WHERE user_id = %s AND revoked_at IS NULL", [now, user_id])


@dataclass(frozen=True)
class Outcome:
    kind: Literal["rotated", "expired", "forbidden"]
    user_id: str | None = None
    token: str | None = None
    #: expired: False only in the rotation race (R32: no Set-Cookie).
    clear_cookie: bool = True
    reason: str | None = None


def rotate(token: str | None) -> Outcome:
    """refreshToken: owner by the token hash (no lock) → the user's advisory lock → the row FOR NO KEY UPDATE."""
    if not well_formed(token):
        return Outcome("expired")
    digest = sha256hex(token)  # type: ignore[arg-type]

    def run(tx: Tx) -> Outcome:
        owner = tx.scalar("SELECT user_id::text FROM refresh_tokens WHERE token_hash = %s", [digest])
        if owner is None:
            return Outcome("expired")
        lock_user_refresh(tx, owner)
        now = tx.now
        row = tx.one(
            "SELECT id::text AS id, user_id::text AS user_id, expires_at, revoked_at, replaced_by "
            "FROM refresh_tokens WHERE token_hash = %s FOR NO KEY UPDATE",
            [digest],
        )
        if row is None:
            return Outcome("expired")
        if row["revoked_at"] is not None:
            if row["replaced_by"] is None:
                return Outcome("expired")
            if (now - row["revoked_at"]).total_seconds() * 1000 <= ROTATION_GRACE_MS:
                return Outcome("expired", clear_cookie=False)
            revoke_chain(tx, row["id"], now)
            return Outcome("expired")
        if row["expires_at"] <= now:
            return Outcome("expired")
        u = tx.one(
            "SELECT u.status, u.deleted_at, o.status AS org_status, o.deleted_at AS org_deleted_at "
            "FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = %s",
            [row["user_id"]],
        )

        def revoke() -> None:
            tx.execute("UPDATE refresh_tokens SET revoked_at = %s WHERE id = %s", [now, row["id"]])

        if u is None or u["deleted_at"] is not None or u["status"] == "INVITED":
            revoke()
            return Outcome("expired")
        if u["status"] == "BLOCKED":
            revoke()
            return Outcome("forbidden", reason="USER_BLOCKED")
        if u["org_status"] != "ACTIVE" or u["org_deleted_at"] is not None:
            revoke()
            return Outcome("forbidden", reason="ORGANIZATION_NOT_ACTIVE")
        next_id, next_token = _insert(row["user_id"])
        tx.execute("UPDATE refresh_tokens SET revoked_at = %s, replaced_by = %s WHERE id = %s",
                   [now, next_id, row["id"]])
        return Outcome("rotated", user_id=row["user_id"], token=next_token)

    return with_tx(run)


def revoke(token: str | None) -> None:
    """logout: revokes the presented token if it is live (idempotent)."""
    if not well_formed(token):
        return
    sql.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = %s AND revoked_at IS NULL",
                [sha256hex(token)])  # type: ignore[arg-type]
