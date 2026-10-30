"""
TOTP (R35), the port of backend-express/src/security/totp.ts (otplib): RFC 6238, SHA1, 6 digits, 30 s step, ±1 step
accepted. `verify` returns the time step the code belongs to, so the caller can refuse a step already accepted for the
user (`totp-used:{userId}:{step}`, R82). The otpauth URL is otplib's `keyuri` byte for byte.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
from datetime import datetime
from urllib.parse import quote

STEP_SEC = 30
DIGITS = 6
ISSUER = "AgroTrace"


def generate_secret() -> str:
    """20 random bytes as Base32 (32 characters, contract pattern ^[A-Z2-7]{16,64}$)."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii")


def _component(s: str) -> str:
    """JavaScript encodeURIComponent."""
    return quote(s, safe="-_.!~*'()")


def otpauth_url(email: str, secret: str) -> str:
    issuer = _component(ISSUER)
    return (f"otpauth://totp/{issuer}:{_component(email)}?secret={secret}&period={STEP_SEC}&digits={DIGITS}"
            f"&algorithm=SHA1&issuer={issuer}")


def _key(secret: str) -> bytes:
    s = secret.upper().replace(" ", "")
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, step: int) -> str:
    """The HOTP code of time step `step`."""
    digest = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**DIGITS).zfill(DIGITS)


def verify(secret: str, code: str, now: datetime | float) -> int | None:
    """The accepted step (now, then −1, then +1) of `code`, or None."""
    t = now.timestamp() if isinstance(now, datetime) else now
    current = int(t // STEP_SEC)
    try:
        candidates = [(d, code_at(secret, current + d)) for d in (0, -1, 1)]
    except (ValueError, TypeError):
        return None
    for delta, expected in candidates:
        if hmac.compare_digest(expected, code):
            return current + delta
    return None
