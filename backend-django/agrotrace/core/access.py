"""
Role checks from the contract (`x-roles`, `x-org-admin`), read by operationId so routes cannot drift from it:
`ANY` = any authenticated role; `x-org-admin` — every role but ADMIN must be the head of its organization.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core.problem import AppProblem
from agrotrace.security.jwt import Principal


def is_public(op: dict[str, Any]) -> bool:
    return "PUBLIC" in (op.get("x-roles") or [])


def allowed(op: dict[str, Any], p: Principal) -> bool:
    roles = op.get("x-roles") or []
    role_ok = "ANY" in roles or any(r in roles for r in p.roles)
    admin_ok = op.get("x-org-admin") is not True or "ADMIN" in p.roles or p.org_admin
    return role_ok and admin_ok


def require(op: dict[str, Any], p: Principal) -> None:
    if not allowed(op, p):
        raise AppProblem(403, "FORBIDDEN")
