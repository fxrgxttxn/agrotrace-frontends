"""
Users (contracts/openapi/paths/users.yaml, FR-IAM-02), the port of backend-express/src/modules/users/service.ts: a
head manages the own organization's employees, ADMIN every user; a user outside that scope is invisible (404). Check
order (info.description): 401 → 403 by role / head → 400 schema → 404 → 409 INVALID_TRANSITION → 400 by references.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from django.db import IntegrityError

from agrotrace.core import audit, config, sql
from agrotrace.core.params import QueryReader
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.tx import Tx, is_unique_violation, with_tx
from agrotrace.infra import i18n, mailer
from agrotrace.infra.redis import client as redis
from agrotrace.modules.auth import sessions
from agrotrace.modules.users.mappers import load_user_views
from agrotrace.modules.users.roles import ROLE_ORDER, roles_fit_type
from agrotrace.modules.users.serializers import ROLE_CODES
from agrotrace.security.jwt import Principal
from agrotrace.security.tokens import new_opaque_token, sha256hex

INVITE_TTL_SEC = 7 * 24 * 3600
USER_STATUSES = ("INVITED", "ACTIVE", "BLOCKED")
SORT_FIELDS = ("fullName", "email", "createdAt")
_ORDER = {"fullName": 'u.full_name COLLATE "C"', "email": 'u.email::text COLLATE "C"', "createdAt": "u.created_at"}


def is_admin(p: Principal) -> bool:
    return "ADMIN" in p.roles


def view(user_id: str) -> dict[str, Any]:
    views = load_user_views([user_id])
    if not views:
        raise RuntimeError(f"user {user_id} vanished")
    return views[0]


def list_users(p: Principal, request) -> dict[str, Any]:
    """Own organization for a head, everybody (organizationId filter) for ADMIN (R51)."""
    q = QueryReader(request)
    page, size, sort = q.page(SORT_FIELDS, "fullName,asc")
    text = q.q()
    organization_id = q.uuid("organizationId")
    if q.has("organizationId") and not is_admin(p):
        q.errors["organizationId"] = ["validation.organizationId.notAllowed"]
        organization_id = None
    status = q.enum_of("status", USER_STATUSES)
    role = q.enum_of("role", ROLE_CODES)
    q.done()

    where = ["u.deleted_at IS NULL"]
    params: list[Any] = []
    org_id = organization_id if is_admin(p) else p.org_id
    if org_id:
        where.append("u.organization_id = %s")
        params.append(org_id)
    if status:
        where.append("u.status = %s")
        params.append(status)
    if role:
        where.append("EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id "
                     "WHERE ur.user_id = u.id AND r.code = %s)")
        params.append(role)
    if text is not None:
        # Substring, case-insensitive; `%`, `_`, `\` are ordinary characters (no LIKE).
        where.append("(position(lower(%s) in lower(u.full_name)) > 0 OR position(lower(%s) in lower(u.email::text)) > 0)")
        params += [text, text]
    cond = " AND ".join(where)
    total = sql.scalar(f"SELECT count(*) FROM users u WHERE {cond}", params)
    direction = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(
        f"SELECT u.id::text AS id FROM users u WHERE {cond} "
        f'ORDER BY {_ORDER[sort.field]} {direction} NULLS LAST, u.id::text COLLATE "C" LIMIT %s OFFSET %s',
        [*params, size, (page - 1) * size],
    )
    return {"items": load_user_views([r["id"] for r in rows]), "page": page, "size": size, "total": int(total)}


def invite(p: Principal, body: dict[str, Any]) -> dict[str, Any]:
    """INVITED user + `invite:{sha256hex(token)}` (7 days, R82) + the letter with the link."""
    email = body["email"].lower()
    errors: dict[str, list[str]] = {}
    org_id = p.org_id
    if "organizationId" in body:
        if is_admin(p):
            org_id = body["organizationId"].lower()
        else:
            errors["organizationId"] = ["validation.organizationId.notAllowed"]
    org = sql.one("SELECT id::text AS id, name, type FROM organizations WHERE id = %s AND deleted_at IS NULL", [org_id])
    taken = sql.scalar("SELECT 1 FROM users WHERE email = %s", [email])
    if taken:
        errors["email"] = ["validation.email.taken"]
    roles = body["roles"]
    if org is None:
        errors["organizationId"] = ["validation.notFound"]
    elif not roles_fit_type(roles, org["type"]) or ("ADMIN" in roles and not is_admin(p)):
        errors["roles"] = ["validation.notAllowed"]
    if errors:
        raise validation_problem(errors)
    assert org is not None

    user_id = str(uuid.uuid4())
    token = new_opaque_token()
    # Written before the row: a key whose user never got committed is harmless (acceptInvite → TOKEN_EXPIRED).
    redis().set(f"invite:{sha256hex(token)}",
                json.dumps({"userId": user_id, "exp": int(time.time()) + INVITE_TTL_SEC}, separators=(",", ":")),
                ex=INVITE_TTL_SEC)

    def run(tx: Tx) -> None:
        # No password until the invitation is accepted: '!' is no PHC hash and never verifies.
        tx.execute("INSERT INTO users (id, organization_id, email, password_hash, full_name, is_org_admin, status, "
                   "created_by) VALUES (%s, %s, %s, '!', %s, %s, 'INVITED', %s)",
                   [user_id, org["id"], email, body["fullName"], body["isOrgAdmin"], p.user_id])
        tx.execute("INSERT INTO user_roles (user_id, role_id) SELECT %s, id FROM roles WHERE code = ANY(%s)",
                   [user_id, list(roles)])
        audit.record(tx, action="inviteUser", entity_type="user", entity_id=user_id, actor=p,
                     diff=audit.audit_diff(None, {"email": email, "fullName": body["fullName"], "roles": list(roles),
                                                  "isOrgAdmin": body["isOrgAdmin"], "status": "INVITED",
                                                  "organizationId": org["id"]}))

    try:
        with_tx(run)
    except IntegrityError as e:
        if is_unique_violation("users_email_key")(e):
            raise validation_problem({"email": ["validation.email.taken"]}) from None
        raise
    link = f"{config.get().PUBLIC_BASE_URL}/invite/{token}"
    mailer.send("invite", email, i18n.t("mail.invite.subject", {"organizationName": org["name"]}),
                i18n.t("mail.invite.body", {"organizationName": org["name"], "link": link}))
    return view(user_id)


def update(p: Principal, user_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Roles, head flag, status ACTIVE ↔ BLOCKED (blocking revokes refresh tokens), R37."""

    def run(tx: Tx) -> None:
        # P12: the per-user refresh lock comes before any row lock of a transaction that revokes tokens.
        if body.get("status") == "BLOCKED":
            sessions.lock_user_refresh(tx, user_id)
        u = tx.one(
            "SELECT u.id::text AS id, u.organization_id::text AS organization_id, u.status, u.is_org_admin, "
            "o.type AS org_type FROM users u JOIN organizations o ON o.id = u.organization_id "
            "WHERE u.id = %s AND u.deleted_at IS NULL FOR NO KEY UPDATE OF u",
            [user_id],
        )
        if u is None or (not is_admin(p) and u["organization_id"] != p.org_id):
            raise AppProblem(404, "NOT_FOUND")
        if "status" in body and u["status"] == "INVITED":
            raise AppProblem(409, "INVALID_TRANSITION", params={"from": "INVITED", "to": body["status"]})
        errors: dict[str, list[str]] = {}
        if u["id"] == p.user_id:
            for f in ("roles", "isOrgAdmin", "status"):
                if f in body:
                    errors[f] = ["validation.notAllowed"]
        if "roles" in body and "roles" not in errors and not roles_fit_type(body["roles"], u["org_type"]):
            errors["roles"] = ["validation.notAllowed"]
        if errors:
            raise validation_problem(errors)
        current = [r["code"] for r in tx.all("SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id "
                                             "WHERE ur.user_id = %s ORDER BY r.id", [user_id])]
        before = {"roles": current, "isOrgAdmin": u["is_org_admin"], "status": u["status"]}
        after = {
            "roles": [r for r in ROLE_ORDER if r in body["roles"]] if "roles" in body else current,
            "isOrgAdmin": body.get("isOrgAdmin", u["is_org_admin"]),
            "status": body.get("status", u["status"]),
        }
        diff = audit.audit_diff(before, after)
        if not diff:
            return
        now = tx.now
        if "roles" in diff:
            tx.execute("DELETE FROM user_roles WHERE user_id = %s", [user_id])
            tx.execute("INSERT INTO user_roles (user_id, role_id) SELECT %s, id FROM roles WHERE code = ANY(%s)",
                       [user_id, after["roles"]])
        tx.execute("UPDATE users SET is_org_admin = %s, status = %s, updated_at = %s WHERE id = %s",
                   [after["isOrgAdmin"], after["status"], now, user_id])
        if "status" in diff and after["status"] == "BLOCKED":
            sessions.revoke_all(tx, user_id, now)
        audit.record(tx, action="updateUser", entity_type="user", entity_id=user_id, actor=p, diff=diff)

    with_tx(run)
    return view(user_id)


def avatar_file(user_id: str) -> dict[str, Any]:
    """getUserAvatar — any authenticated user (п. 4.2); no user, no avatar → 404."""
    from agrotrace.modules.files.services import columns

    f = sql.one(f"SELECT {columns('f')} FROM users u JOIN files f ON f.id = u.avatar_file_id "
                "WHERE u.id = %s AND u.deleted_at IS NULL AND f.deleted_at IS NULL", [user_id])
    if f is None:
        raise AppProblem(404, "NOT_FOUND")
    return f
