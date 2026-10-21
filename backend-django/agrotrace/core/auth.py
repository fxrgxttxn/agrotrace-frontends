"""
Bearer authentication (contract `security: bearer`), the port of backend-express/src/http/auth.ts: the principal
comes from the verified JWT claims only; a blocked user's access token lives out its ≤ 15 minutes. DRF sees
`BearerAuthentication` only for its `authenticate_header` (so DRF's own NotAuthenticated stays 401, never 403); the
check itself runs in ContractView.initial in the contract's order.
"""

from __future__ import annotations

import re

from rest_framework.authentication import BaseAuthentication

from agrotrace.core.problem import AppProblem
from agrotrace.security.jwt import Principal, verify_access_token

BEARER = re.compile(r"Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", re.I)


def _token(request) -> str | None:
    m = BEARER.fullmatch(request.META.get("HTTP_AUTHORIZATION", ""))
    return m.group(1) if m else None


def bearer_principal(request) -> Principal | None:
    """The principal of a valid Bearer token, or None (no header, malformed or invalid) — never raises 401."""
    token = _token(request)
    verified = verify_access_token(token) if token else None
    return verified[0] if verified else None


def authenticate(request) -> Principal:
    """The verified principal, or 401 UNAUTHORIZED."""
    p = bearer_principal(request)
    if p is None:
        raise AppProblem(401, "UNAUTHORIZED")
    return p


class BearerAuthentication(BaseAuthentication):
    def authenticate(self, request):
        return None

    def authenticate_header(self, request) -> str:
        return "Bearer"
