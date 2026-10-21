"""
Access tokens (contract `AccessToken`, P12): JWT HS256 with the shared JWT_SECRET, 15 minutes, claims `sub`, `org`,
`roles`, `org_admin`, `exp`, `iat`, `jti` — a token issued by any backend is accepted by any other (the port of
backend-express/src/security/jwt.ts). Task 1 provides verification for ContractView; Task 2 completes issuing and
its vectors (test_jwt.py).
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime

import jwt as pyjwt

from agrotrace.core import config

ACCESS_TTL_SEC = 900
ROLES = frozenset({"FARMER", "PROCESSOR", "LAB", "RETAILER", "INSPECTOR", "ADMIN"})
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


@dataclass(frozen=True)
class Principal:
    """The authenticated principal of a request — from the verified claims only, no database read."""

    user_id: str
    org_id: str
    roles: tuple[str, ...]
    org_admin: bool


def issue_access_token(p: Principal, now: datetime) -> str:
    iat = int(now.timestamp())
    claims = {"org": p.org_id, "roles": list(p.roles), "org_admin": p.org_admin, "sub": p.user_id, "iat": iat,
              "exp": iat + ACCESS_TTL_SEC, "jti": str(uuid.uuid4())}
    return pyjwt.encode(claims, config.get().JWT_SECRET, algorithm="HS256", headers={"typ": "JWT"})


def _integral(v: object) -> bool:
    return (type(v) is int) or (type(v) is float and v.is_integer())


def verify_access_token(token: str) -> tuple[Principal, int] | None:
    """(principal, exp) of a valid token; None for anything else."""
    try:
        header = pyjwt.get_unverified_header(token)
        if header.get("alg") != "HS256" or "crit" in header:
            return None
        payload = pyjwt.decode(
            token,
            config.get().JWT_SECRET,
            algorithms=["HS256"],
            options={"require": ["exp", "iat", "sub", "jti"], "verify_iat": False, "verify_exp": False,
                     "verify_sub": False, "verify_jti": False},
        )
    except pyjwt.PyJWTError:
        return None
    sub, org, roles = payload.get("sub"), payload.get("org"), payload.get("roles")
    org_admin, exp, iat, jti = payload.get("org_admin"), payload.get("exp"), payload.get("iat"), payload.get("jti")
    if not (isinstance(sub, str) and _UUID.fullmatch(sub) and isinstance(org, str) and _UUID.fullmatch(org)):
        return None
    if type(org_admin) is not bool or not isinstance(jti, str) or not _integral(exp) or not _integral(iat):
        return None
    if not isinstance(roles, list) or not roles or not all(isinstance(r, str) and r in ROLES for r in roles):
        return None
    # jose: expired when exp <= now (seconds).
    if int(exp) <= int(time.time()):
        return None
    return Principal(user_id=sub, org_id=org, roles=tuple(roles), org_admin=org_admin), int(exp)
