"""
File URLs (contract `SignedFileUrl` / `PublicFileUrl`, R28/R34/R39/R88), the port of backend-express/src/infra/
file-urls.ts: logos and product images are public (`/api/v1/public/files/{id}`); avatars, lab protocols, QR and
reports are signed — key = the RAW BYTES of HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1"), `sig` =
hex(HMAC-SHA256(key, "{id lower-case}:{exp}")), `exp` = now + 3600 (Unix seconds). The same recipe in every backend,
so a URL signed by one is served by any. `exp` is checked against the process clock (a URL, not written data).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from datetime import datetime
from functools import cache

from agrotrace.core import config

SIGNED_URL_TTL_SEC = 3600
_SIG = re.compile(r"[0-9a-f]{64}")
#: P17, D-M11: `exp` exactly as the server issues it — a decimal without sign or leading zeros, at most 12 digits.
EXP_PATTERN = re.compile(r"[1-9][0-9]{0,11}")


@cache
def _key(secret: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), b"agrotrace:file-url:v1", hashlib.sha256).digest()


def signature(file_id: str, exp: int, secret: str | None = None) -> str:
    key = _key(secret if secret is not None else config.get().JWT_SECRET)
    return hmac.new(key, f"{file_id.lower()}:{exp}".encode(), hashlib.sha256).hexdigest()


def _now_sec(now: datetime | float | None) -> int:
    if now is None:
        return int(time.time())
    return int(now.timestamp() if isinstance(now, datetime) else now)


def signed(file_id: str, now: datetime | float | None = None) -> str:
    exp = _now_sec(now) + SIGNED_URL_TTL_SEC
    return f"/api/v1/files/{file_id.lower()}?exp={exp}&sig={signature(file_id, exp)}"


def verify(file_id: str, exp: str | int, sig: str, now: datetime | float | None = None) -> bool:
    """A signature from a query: `exp` (the query text) by EXP_PATTERN and not in the past, `sig` 64 lower-case hex,
    compared in constant time."""
    if isinstance(exp, str):
        if not EXP_PATTERN.fullmatch(exp):
            return False
        exp_n = int(exp)
    elif type(exp) is int and exp > 0:
        exp_n = exp
    else:
        return False
    if exp_n < _now_sec(now):
        return False
    if not isinstance(sig, str) or not _SIG.fullmatch(sig):
        return False
    return hmac.compare_digest(signature(file_id, exp_n), sig)


def public_url(file_id: str) -> str:
    return f"/api/v1/public/files/{file_id.lower()}"
