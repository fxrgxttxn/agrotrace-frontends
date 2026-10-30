"""
Passwords (spec 8.8, R31, §8.3), the port of backend-express/src/security/passwords.ts: Argon2id PHC strings
`$argon2id$v=19$m=65536,t=3,p=1$…` (hash 32 bytes, salt 16, no Django `argon2$` prefix) — the parameters of the seed
and of Express, so every backend verifies every other's hashes. Passwords are compared byte-exact (never trimmed or
normalized, R36).
"""

from __future__ import annotations

import secrets
import threading

from argon2 import PasswordHasher, Type
from argon2.exceptions import Argon2Error, InvalidHashError, VerificationError

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=1, hash_len=32, salt_len=16, type=Type.ID)


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(phc: str, pw: str) -> bool:
    """False for a wrong password and for a stored value that is no valid PHC hash (an invited user's '!')."""
    try:
        return _hasher.verify(phc, pw)
    except (VerificationError, InvalidHashError, Argon2Error, ValueError):
        return False


_dummy: str | None = None
_dummy_lock = threading.Lock()


def dummy_verify(pw: str) -> None:
    """R31 step 2: an unknown email still costs one Argon2 verification with the same parameters."""
    global _dummy
    if _dummy is None:
        with _dummy_lock:
            if _dummy is None:
                _dummy = hash_password("dummy-" + secrets.token_hex(16))
    verify_password(_dummy, pw)
