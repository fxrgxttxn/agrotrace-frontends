"""Opaque one-time tokens (R82): 32 random bytes, base64url without padding (43 characters); stored only as sha256
hex (the port of backend-express/src/security/tokens.ts)."""

from __future__ import annotations

import base64
import hashlib
import secrets


def new_opaque_token() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()
