"""
Auth operations (contracts/openapi/paths/auth.yaml), the port of backend-express/src/modules/auth/service.ts. Check
orders are the contract's, step by step; Redis keys and their values are the contract's "Shared Redis keys" (R82,
compact JSON `{"userId":…,"exp":…}`, read by parsing — P9). Transactions touch only the database (`with_tx` may re-run
them); Redis writes and mail happen outside them.

Audit (decision 3 of Express Task 2): registerOrganization (organization + user creation), acceptInvite,
resetPassword and setupTwoFactor; creation writes `password: [null, "***"]`, a change `["***", "***"]`.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError

from agrotrace.core import audit, config, ratelimit, sql
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, is_unique_violation, with_tx
from agrotrace.infra import dadata, i18n, mailer
from agrotrace.infra.redis import client as redis
from agrotrace.modules.auth import sessions
from agrotrace.modules.me.mappers import load_me
from agrotrace.modules.users.roles import ROLE_OF_TYPE
from agrotrace.security import totp
from agrotrace.security.jwt import ACCESS_TTL_SEC, Principal, issue_access_token
from agrotrace.security.passwords import dummy_verify, hash_password, verify_password
from agrotrace.security.tokens import new_opaque_token, sha256hex

LOCK_AFTER = 5
LOCK_MINUTES = 15
CHALLENGE_TTL_SEC = 300
CHALLENGE_MAX_FAILS = 5
TOTP_USED_TTL_SEC = 90
PWRESET_TTL_SEC = 3600


def _trust_initial() -> int:
    rules = json.loads((config.ROOT / "contracts" / "rules" / "trust-rating.json").read_text("utf-8"))
    return int(rules["initial"])


def _now_sec() -> int:
    return int(time.time())


def key_value(raw: bytes | str | None) -> dict[str, Any] | None:
    """`{"userId", "exp"}` values of pwreset/invite/2fa keys (R82): parsed, `exp` not in the past."""
    if raw is None:
        return None
    try:
        v = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(v, dict):
        return None
    user_id, exp = v.get("userId"), v.get("exp")
    if not isinstance(user_id, str) or type(exp) not in (int, float) or exp < _now_sec():
        return None
    return {"userId": user_id, "exp": exp}


def _compact(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def forbidden(reason: str) -> AppProblem:
    return AppProblem(403, "FORBIDDEN", params={"reason": reason})


def token_expired(status: int, title: str | None = None) -> AppProblem:
    return AppProblem(status, "TOKEN_EXPIRED", title=title)


@dataclass(frozen=True)
class Session:
    access_token: str
    expires_in: int
    refresh_token: str
    user: dict[str, Any]

    def body(self) -> dict[str, Any]:
        return {"twoFactorRequired": False, "accessToken": self.access_token, "expiresIn": self.expires_in,
                "user": self.user}


def access_token_for(user_id: str) -> str:
    me = load_me(user_id)
    if me is None:
        raise RuntimeError(f"access_token_for: user {user_id} vanished")
    p = Principal(user_id=user_id, org_id=me["organization"]["id"], roles=tuple(me["roles"]),
                  org_admin=me["isOrgAdmin"])
    return issue_access_token(p, _wall())


def _wall():
    from datetime import UTC, datetime

    return datetime.fromtimestamp(time.time(), UTC)


def open_session(user_id: str) -> Session:
    """Access token + a new refresh token + Me for an active user."""
    user = load_me(user_id)
    if user is None:
        raise RuntimeError(f"open_session: user {user_id} vanished")
    p = Principal(user_id=user_id, org_id=user["organization"]["id"], roles=tuple(user["roles"]),
                  org_admin=user["isOrgAdmin"])
    refresh = sessions.issue(user_id)
    return Session(issue_access_token(p, _wall()), ACCESS_TTL_SEC, refresh, user)


_AUTH_USER = """
SELECT u.id::text AS id, u.email::text AS email, u.full_name, u.password_hash, u.status, u.failed_logins,
       u.locked_until, u.totp_enabled, u.totp_secret, o.status AS org_status,
       (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked, o.deleted_at AS org_deleted_at
  FROM users u JOIN organizations o ON o.id = u.organization_id
 WHERE u.deleted_at IS NULL AND {where}
"""


def load_auth_user(*, email: str | None = None, user_id: str | None = None) -> dict[str, Any] | None:
    if email is not None:
        return sql.one(_AUTH_USER.format(where="u.email = %s"), [email])
    return sql.one(_AUTH_USER.format(where="u.id = %s"), [user_id])


def status_problem(u: dict[str, Any]) -> AppProblem | None:
    """R31 step 5 (decision 5 of Express Task 2): USER_BLOCKED → USER_INVITED → ORGANIZATION_NOT_ACTIVE."""
    if u["status"] == "BLOCKED":
        return forbidden("USER_BLOCKED")
    if u["status"] == "INVITED":
        return forbidden("USER_INVITED")
    if u["org_status"] != "ACTIVE" or u["org_deleted_at"] is not None:
        return forbidden("ORGANIZATION_NOT_ACTIVE")
    return None


def totp_used_key(user_id: str, step: int) -> str:
    return f"totp-used:{user_id}:{step}"


def mark_totp_used(user_id: str, step: int) -> bool:
    """SET NX EX 90; False — it already was (a parallel replay won)."""
    return bool(redis().set(totp_used_key(user_id, step), "1", ex=TOTP_USED_TTL_SEC, nx=True))


def _locked(locked_until) -> AppProblem:
    return AppProblem(401, "ACCOUNT_LOCKED", params={"lockedUntil": iso(locked_until)})


# ── login ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def login(body: dict[str, Any]) -> Session | str:
    """R31 steps 2–6 (step 1, the `login-ip` limit, ran in ContractView); a Session or a 2FA challengeId."""
    email = body["email"].lower()
    u = load_auth_user(email=email)
    if u is None:
        dummy_verify(body["password"])
        raise AppProblem(401, "INVALID_CREDENTIALS")
    if u["is_locked"] and u["locked_until"] is not None:
        raise _locked(u["locked_until"])

    if not verify_password(u["password_hash"], body["password"]):
        # One statement: concurrent failures never lose a count, and a lock is set exactly once (M3: DB clock).
        r = sql.one(
            """
            UPDATE users SET
              failed_logins = CASE WHEN failed_logins + 1 >= %s THEN 0 ELSE failed_logins + 1 END,
              locked_until = CASE WHEN failed_logins + 1 >= %s
                                  THEN now() + make_interval(mins => %s) ELSE locked_until END
             WHERE id = %s AND (locked_until IS NULL OR locked_until <= now())
            RETURNING locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked
            """,
            [LOCK_AFTER, LOCK_AFTER, LOCK_MINUTES, u["id"]],
        )
        locked_until = r["locked_until"] if r is not None and r["locked"] else None
        if r is None:
            again = load_auth_user(user_id=u["id"])
            locked_until = again["locked_until"] if again else None
        if locked_until is not None:
            raise _locked(locked_until)
        raise AppProblem(401, "INVALID_CREDENTIALS")

    reset = sql.scalar(
        "UPDATE users SET failed_logins = 0 WHERE id = %s AND (locked_until IS NULL OR locked_until <= now()) "
        "RETURNING id::text",
        [u["id"]],
    )
    if reset is None:
        again = load_auth_user(user_id=u["id"])
        until = again["locked_until"] if again and again["locked_until"] is not None else sql.scalar("SELECT now()")
        raise _locked(until)
    denied = status_problem(u)
    if denied is not None:
        raise denied

    if u["totp_enabled"]:
        challenge_id = str(uuid.uuid4())
        redis().set(f"2fa:{challenge_id}", _compact({"userId": u["id"], "exp": _now_sec() + CHALLENGE_TTL_SEC}),
                    ex=CHALLENGE_TTL_SEC)
        return challenge_id
    return open_session(u["id"])


# ── 2FA ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def verify_two_factor(body: dict[str, Any]) -> Session:
    """R35: single-use challenge, 5 minutes, at most 5 wrong codes; statuses re-checked (decision 4: 401)."""
    key = f"2fa:{body['challengeId']}"
    fail_key = f"2fa-fail:{body['challengeId']}"
    r = redis()

    def expired() -> AppProblem:
        return token_expired(401, "Two-factor challenge expired")

    challenge = key_value(r.get(key))
    if challenge is None:
        raise expired()
    u = load_auth_user(user_id=challenge["userId"])
    if u is None or not u["totp_enabled"] or not u["totp_secret"] or status_problem(u) is not None:
        r.delete(key, fail_key)
        raise expired()
    # Every attempt reserves one of the 5 slots BEFORE its code is checked; EXISTS in the same MULTI.
    pipe = r.pipeline(transaction=True)
    pipe.exists(key)
    pipe.incr(fail_key)
    pipe.expire(fail_key, CHALLENGE_TTL_SEC, nx=True)
    alive_n, attempt, _ = pipe.execute()
    attempt = int(attempt)
    if int(alive_n) != 1 or attempt > CHALLENGE_MAX_FAILS:
        r.delete(key, fail_key)
        raise expired()

    def wrong() -> AppProblem:
        if attempt >= CHALLENGE_MAX_FAILS:
            r.delete(key, fail_key)
        return AppProblem(401, "INVALID_TWO_FACTOR_CODE", params={"attemptsLeft": CHALLENGE_MAX_FAILS - attempt})

    step = totp.verify(u["totp_secret"], body["code"], time.time())
    if step is None or r.exists(totp_used_key(u["id"], step)) == 1:
        raise wrong()
    # Single use: whoever deletes the challenge first wins; only then is the step marked used.
    if r.getdel(key) is None:
        raise expired()
    r.delete(fail_key)
    if not mark_totp_used(u["id"], step):
        raise AppProblem(401, "INVALID_TWO_FACTOR_CODE", params={"attemptsLeft": 0})
    return open_session(u["id"])


def setup_two_factor(p: Principal, body: dict[str, Any]) -> dict[str, Any]:
    """Two steps (R29), TOTP parameters R35."""
    u = sql.one("SELECT id::text AS id, email::text AS email, totp_enabled, totp_secret FROM users "
                "WHERE id = %s AND deleted_at IS NULL", [p.user_id])
    if u is None:
        raise AppProblem(401, "UNAUTHORIZED")

    def enabled() -> AppProblem:
        return AppProblem(409, "INVALID_TRANSITION", params={"from": "ENABLED"})

    if u["totp_enabled"]:
        raise enabled()

    if "code" not in body:
        secret = totp.generate_secret()

        def first(tx: Tx) -> bool:
            n = tx.execute("UPDATE users SET totp_secret = %s, updated_at = now() WHERE id = %s AND NOT totp_enabled",
                           [secret, u["id"]])
            if n == 0:
                return False
            audit.record(tx, action="setupTwoFactor", entity_type="user", entity_id=u["id"], actor=p,
                         diff={"totpSecret": [None if u["totp_secret"] is None else audit.SECRET, audit.SECRET]})
            return True

        if not with_tx(first):
            raise enabled()
        return {"totpEnabled": False, "secret": secret, "otpauthUrl": totp.otpauth_url(u["email"].lower(), secret)}

    def invalid_code() -> AppProblem:
        return AppProblem(400, "INVALID_TWO_FACTOR_CODE")

    if not u["totp_secret"]:
        raise invalid_code()
    step = totp.verify(u["totp_secret"], body["code"], time.time())
    if step is None or redis().exists(totp_used_key(u["id"], step)) == 1:
        raise invalid_code()
    secret = u["totp_secret"]

    def second(tx: Tx) -> str:
        n = tx.execute("UPDATE users SET totp_enabled = true, updated_at = now() "
                       "WHERE id = %s AND NOT totp_enabled AND totp_secret = %s", [u["id"], secret])
        if n == 0:
            now_enabled = tx.scalar("SELECT totp_enabled FROM users WHERE id = %s", [u["id"]])
            return "enabled" if now_enabled else "replaced"
        audit.record(tx, action="setupTwoFactor", entity_type="user", entity_id=u["id"], actor=p,
                     diff={"totpEnabled": [False, True]})
        return "ok"

    outcome = with_tx(second)
    if outcome == "enabled":
        raise enabled()
    if outcome == "replaced":
        raise invalid_code()
    mark_totp_used(u["id"], step)
    return {"totpEnabled": True}


# ── password reset ────────────────────────────────────────────────────────────────────────────────────────────────

def forgot_password(body: dict[str, Any]) -> None:
    """Always 204 for a valid body under the limit; the letter only if the account exists."""
    email = body["email"].lower()
    ratelimit.hit("forgot", email)
    u = sql.one("SELECT id::text AS id, email::text AS email, full_name FROM users "
                "WHERE email = %s AND deleted_at IS NULL", [email])
    if u is None:
        return
    token = new_opaque_token()
    redis().set(f"pwreset:{sha256hex(token)}", _compact({"userId": u["id"], "exp": _now_sec() + PWRESET_TTL_SEC}),
                ex=PWRESET_TTL_SEC)
    link = f"{config.get().PUBLIC_BASE_URL}/password/reset/{token}"
    mailer.send("passwordReset", u["email"].lower(), i18n.t("mail.passwordReset.subject"),
                i18n.t("mail.passwordReset.body", {"link": link, "fullName": u["full_name"]}))


def reset_password(body: dict[str, Any]) -> None:
    """The body was validated BEFORE the token is consumed (GETDEL, R82/R92; P53: final)."""
    entry = key_value(redis().getdel(f"pwreset:{sha256hex(body['token'])}"))
    if entry is None:
        raise token_expired(400)
    digest = hash_password(body["password"])
    user_id = entry["userId"]

    def run(tx: Tx) -> None:
        # P12: the refresh lock first, then the user row.
        sessions.lock_user_refresh(tx, user_id)
        now = tx.now
        n = tx.execute("UPDATE users SET password_hash = %s, failed_logins = 0, locked_until = NULL, updated_at = %s "
                       "WHERE id = %s AND deleted_at IS NULL", [digest, now, user_id])
        if n == 0:
            raise token_expired(400)
        sessions.revoke_all(tx, user_id, now)
        audit.record(tx, action="resetPassword", entity_type="user", entity_id=user_id, actor=None,
                     actor_id=user_id, diff={"password": [audit.SECRET, audit.SECRET]})

    with_tx(run)


# ── registration ──────────────────────────────────────────────────────────────────────────────────────────────────

def register_organization(body: dict[str, Any]) -> dict[str, Any]:
    """FR-IAM-01; reference errors in one 400 before DaData (decision 6); DaData never blocks (MANUAL_CHECK)."""
    admin = body["admin"]
    email = admin["email"].lower()
    errors: dict[str, list[str]] = {}
    region_id = sql.scalar("SELECT id::text FROM regions WHERE code = %s", [body["regionCode"]])
    inn_taken = sql.scalar("SELECT 1 FROM organizations WHERE inn = %s", [body["inn"]])
    email_taken = sql.scalar("SELECT 1 FROM users WHERE email = %s", [email])
    if inn_taken:
        errors["inn"] = ["validation.inn.taken"]
    if region_id is None:
        errors["regionCode"] = ["validation.notFound"]
    if email_taken:
        errors["admin.email"] = ["validation.email.taken"]
    if errors:
        raise validation_problem(errors)

    party = dadata.find_party(body["inn"])
    if party.status == "found":
        name, address, status = party.name, party.address, "PENDING"
    elif party.status == "notFound":
        raise validation_problem({"inn": ["validation.inn.notFound"]})
    elif "name" not in body:
        raise validation_problem({"name": ["validation.required"]})
    else:
        name, address, status = body["name"], None, "MANUAL_CHECK"
    org_type = body["type"]
    trust = _trust_initial() if org_type == "FARM" else None
    role = ROLE_OF_TYPE[org_type]
    digest = hash_password(admin["password"])

    def run(tx: Tx) -> dict[str, Any]:
        # FOR KEY SHARE (P23): a region deleted since the check → 400, never a foreign-key 500.
        kept = tx.scalar("SELECT id::text FROM regions WHERE id = %s FOR KEY SHARE", [region_id])
        if kept is None:
            raise validation_problem({"regionCode": ["validation.notFound"]})
        org_id = tx.scalar(
            "INSERT INTO organizations (type, name, inn, address, region_id, trust_rating, status) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id::text",
            [org_type, name, body["inn"], address, region_id, trust, status],
        )
        user_id = tx.scalar(
            "INSERT INTO users (organization_id, email, password_hash, full_name, is_org_admin, status) "
            "VALUES (%s, %s, %s, %s, true, 'ACTIVE') RETURNING id::text",
            [org_id, email, digest, admin["fullName"]],
        )
        tx.execute("INSERT INTO user_roles (user_id, role_id) SELECT %s, id FROM roles WHERE code = %s",
                   [user_id, role])
        tx.execute("UPDATE organizations SET created_by = %s WHERE id = %s", [user_id, org_id])
        audit.record(tx, action="registerOrganization", entity_type="organization", entity_id=org_id, actor=None,
                     actor_id=user_id, diff=audit.audit_diff(None, {
                         "name": name, "type": org_type, "inn": body["inn"], "address": address,
                         "regionCode": body["regionCode"], "status": status, "trustRating": trust}))
        audit.record(tx, action="registerOrganization", entity_type="user", entity_id=user_id, actor=None,
                     actor_id=user_id, diff=audit.audit_diff(None, {
                         "email": email, "fullName": admin["fullName"], "roles": [role], "isOrgAdmin": True,
                         "status": "ACTIVE", "organizationId": org_id, "password": audit.SECRET}))
        return {"organizationId": org_id, "status": status}

    try:
        return with_tx(run)
    except IntegrityError as e:
        # A parallel registration with the same INN or email won the race (unique constraints).
        if is_unique_violation("organizations_inn_key")(e):
            raise validation_problem({"inn": ["validation.inn.taken"]}) from None
        if is_unique_violation("users_email_key")(e):
            raise validation_problem({"admin.email": ["validation.email.taken"]}) from None
        raise


# ── invitations ───────────────────────────────────────────────────────────────────────────────────────────────────

def accept_invite(body: dict[str, Any]) -> None:
    """INVITED → ACTIVE; the body was validated BEFORE the token is consumed (R92)."""
    entry = key_value(redis().getdel(f"invite:{sha256hex(body['token'])}"))
    if entry is None:
        raise token_expired(400)
    digest = hash_password(body["password"])

    def run(tx: Tx) -> None:
        u = tx.one("SELECT id::text AS id, full_name, status FROM users WHERE id = %s AND deleted_at IS NULL "
                   "FOR NO KEY UPDATE", [entry["userId"]])
        if u is None or u["status"] != "INVITED":
            raise token_expired(400)
        tx.execute("UPDATE users SET full_name = %s, password_hash = %s, status = 'ACTIVE', failed_logins = 0, "
                   "locked_until = NULL, updated_at = now() WHERE id = %s", [body["fullName"], digest, u["id"]])
        diff = audit.audit_diff({"fullName": u["full_name"], "status": u["status"]},
                                {"fullName": body["fullName"], "status": "ACTIVE"})
        diff["password"] = [audit.SECRET, audit.SECRET]
        audit.record(tx, action="acceptInvite", entity_type="user", entity_id=u["id"], actor=None,
                     actor_id=u["id"], diff=diff)

    with_tx(run)
