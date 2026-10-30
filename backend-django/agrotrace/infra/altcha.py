"""
ALTCHA proof of work for the public complaint form (contract getCaptchaChallenge / createPublicComplaint, P40), the
port of backend-express/src/infra/altcha.ts on hashlib/hmac (the v1 recipe and the shared vector
contracts/rules/altcha.json are binding, so a challenge issued by one backend is accepted by any):

  key       = hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1"))  — used as the HMAC key STRING (its UTF-8 bytes),
              unlike the file-URL key (raw bytes)
  salt      = 24 hex chars + "?expires=" + Unix seconds (issue time + 600)
  challenge = sha256hex(salt + number), number ∈ [0, maxnumber] secret
  signature = hex(HMAC-SHA256(key, challenge))

A solution (the `altcha` field) is standard padded base64 (RFC 4648 §4, canonical) of a JSON object {algorithm:
"SHA-256", challenge, number, salt, signature, …extra widget fields}; it is valid when it parses as JSON.parse would,
`number` is written as plain decimal digits (no sign, fraction, exponent or leading zero) and is a safe integer,
`expires` in the salt is not in the past (equal second is valid), sha256hex(salt + number) = challenge and the
signature matches (constant time). Replay protection (`altcha-used:{signature}`) is the caller's.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
from typing import Any

from agrotrace.core import config

ALTCHA_TTL_SEC = 600
ALTCHA_MAX_NUMBER = 100_000
_JS_MAX_SAFE = 2**53 - 1

_B64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_DIGITS = re.compile(r"0|[1-9][0-9]*")
#: JS `/[?&]expires=(\d{1,12})(?:&|$)/` — `\d` is ASCII and `$` the very end in JavaScript.
_EXPIRES = re.compile(r"[?&]expires=([0-9]{1,12})(?:&|\Z)")
_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _utf8(s: str) -> bytes:
    """Node's `update(s, 'utf8')`: a lone surrogate is encoded as U+FFFD."""
    return _SURROGATE.sub("�", s).encode("utf-8")


def _sha256hex(s: str) -> str:
    return hashlib.sha256(_utf8(s)).hexdigest()


def _hmac_hex(key: str, msg: str) -> str:
    return hmac.new(_utf8(key), _utf8(msg), hashlib.sha256).hexdigest()


def key(jwt_secret: str) -> str:
    """hex(HMAC-SHA256(jwt_secret, "agrotrace:altcha:v1")) — a hex STRING, used as a key by its UTF-8 bytes."""
    return _hmac_hex(jwt_secret, "agrotrace:altcha:v1")


def _key(k: str | None) -> str:
    return k if k is not None else key(config.get().JWT_SECRET)


def challenge(now_ms: int, *, hmac_key: str | None = None) -> dict[str, Any]:
    """A new challenge (getCaptchaChallenge), valid until `floor(now_ms / 1000) + 600`."""
    expires = now_ms // 1000 + ALTCHA_TTL_SEC
    salt = f"{secrets.token_hex(12)}?expires={expires}"
    ch = _sha256hex(salt + str(secrets.randbelow(ALTCHA_MAX_NUMBER + 1)))
    return {"algorithm": "SHA-256", "challenge": ch, "salt": salt, "signature": _hmac_hex(_key(hmac_key), ch),
            "maxnumber": ALTCHA_MAX_NUMBER}


class _Int(int):
    """A JSON integer with its source text (the JSON.parse reviver's `context.source`)."""

    src: str


def _parse_int(s: str) -> _Int:
    v = _Int(s)
    v.src = s
    return v


def _reject_constant(name: str) -> Any:
    raise ValueError(name)  # NaN / Infinity are not JSON


def _decode(payload: str) -> dict[str, Any] | None:
    """The solution object, or None: canonical padded base64 → UTF-8 (U+FFFD for invalid bytes, as Buffer does) →
    a JSON object (JSON.parse: last duplicate wins, no NaN/Infinity)."""
    if not isinstance(payload, str) or len(payload) % 4 != 0 or not _B64.fullmatch(payload):
        return None
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None
    if base64.b64encode(raw).decode("ascii") != payload:
        return None
    try:
        v = json.loads(raw.decode("utf-8", errors="replace"), parse_int=_parse_int, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    return v if isinstance(v, dict) else None


def verify(payload_b64: str, now_ms: int, *, hmac_key: str | None = None) -> str | None:
    """The signature of a valid, unexpired solution (its replay key), or None."""
    v = _decode(payload_b64)
    if v is None:
        return None
    algorithm, ch, number, salt, signature = (v.get(k) for k in ("algorithm", "challenge", "number", "salt",
                                                                  "signature"))
    if algorithm != "SHA-256" or not isinstance(salt, str) or not isinstance(ch, str):
        return None
    if not isinstance(signature, str) or not _HEX64.fullmatch(signature) or not _HEX64.fullmatch(ch):
        return None
    # `number`: a JSON integer written as plain digits, a safe integer (floats/exponents/signs are refused).
    if not isinstance(number, _Int) or not _DIGITS.fullmatch(number.src) or number > _JS_MAX_SAFE:
        return None
    m = _EXPIRES.search(salt)
    if m is None or int(m.group(1)) * 1000 < now_ms:
        return None
    if _sha256hex(salt + str(int(number))) != ch:
        return None
    if not hmac.compare_digest(bytes.fromhex(_hmac_hex(_key(hmac_key), ch)), bytes.fromhex(signature)):
        return None
    return signature


def now_ms() -> int:
    """The process clock in milliseconds (a challenge's expiry, never written data)."""
    import time

    return time.time_ns() // 1_000_000
