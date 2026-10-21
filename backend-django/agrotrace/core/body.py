"""
JSON request bodies exactly as Express reads them (express.json: body-parser 1.20, `strict`, 12 MiB, types
`application/json` and `application/*+json`), before routing — a malformed body on a not-yet-implemented operation is
400 like on Express (contract-shape.test.ts):

- another Content-Type (or none): not read here; the body counts as `{}` (Express `req.body`), multipart is the
  operation's business (core.multipart);
- Content-Length or the decoded size over 12 MiB → 413 FILE_TOO_LARGE `{maxBytes: 12582912}`;
- Content-Encoding gzip/deflate/identity (else `_root [validation.invalid]`); charset must be `utf-*` (default utf-8),
  else `_root [validation.invalid]` (P7); invalid UTF-8 bytes decode to U+FFFD and a leading BOM is dropped, as
  iconv-lite does;
- `strict`: the first non-blank character must be `{` or `[`; then JSON.parse semantics — no NaN/Infinity literals,
  numbers are JS numbers (`5.0` is 5, integers beyond 2^53 lose precision); any failure → `_root [validation.invalid]`;
- the raw bytes are kept (`request.raw_body`) for the Idempotency-Key fingerprint (R48).
"""

from __future__ import annotations

import codecs
import json
import re
import zlib
from typing import Any

from agrotrace.core.problem import JSON_BODY_LIMIT_BYTES, root_invalid, too_large

_JS_SAFE = 2**53


def is_json_type(content_type: str | None) -> bool:
    """type-is match of `application/json` / `application/*+json` (parameters ignored, case-insensitive)."""
    if not content_type:
        return False
    media = content_type.split(";", 1)[0].strip().lower()
    return media == "application/json" or bool(re.fullmatch(r"application/[^/\s]+\+json", media))


def _charset(content_type: str) -> str:
    for part in content_type.split(";")[1:]:
        k, _, v = part.strip().partition("=")
        if k.strip().lower() == "charset":
            return v.strip().strip('"').lower()
    return "utf-8"


def _parse_float(s: str) -> Any:
    f = float(s)
    return int(f) if f.is_integer() and abs(f) < _JS_SAFE else f


def _parse_int(s: str) -> Any:
    n = int(s)
    return n if abs(n) < _JS_SAFE else float(n)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def js_json_parse(text: str) -> Any:
    """JSON.parse: Python's json with JS numbers and without the NaN/Infinity extensions."""
    return json.loads(text, parse_float=_parse_float, parse_int=_parse_int, parse_constant=_reject_constant)


def _inflate(raw: bytes, encoding: str) -> bytes:
    enc = encoding.strip().lower() or "identity"
    if enc == "identity":
        return raw
    if enc not in ("gzip", "deflate"):
        raise root_invalid()
    d = zlib.decompressobj(16 + zlib.MAX_WBITS if enc == "gzip" else zlib.MAX_WBITS)
    try:
        out = d.decompress(raw, JSON_BODY_LIMIT_BYTES + 1)
    except zlib.error:
        raise root_invalid() from None
    if len(out) > JSON_BODY_LIMIT_BYTES:
        raise too_large()
    return out


def decode_json_bytes(raw: bytes, content_type: str) -> Any:
    charset = _charset(content_type)
    if not charset.startswith("utf-"):
        raise root_invalid()
    try:
        codec = codecs.lookup(charset)
    except LookupError:
        raise root_invalid() from None
    text = raw.decode(codec.name, errors="replace")
    if text.startswith("﻿"):
        text = text[1:]
    if not text:
        return {}
    m = re.match(r"[ \t\n\r]*(.)", text, re.S)
    if m is None:
        # Only white space: body-parser's strict check fails on it.
        raise root_invalid()
    if m.group(1) not in "{[":
        raise root_invalid()
    try:
        return js_json_parse(text)
    except (ValueError, RecursionError):
        raise root_invalid() from None


def read_json_body(request) -> tuple[Any, bytes]:
    """(parsed body, raw bytes) of a JSON request; `({}, b"")` for an empty one (body-parser)."""
    length = request.META.get("CONTENT_LENGTH")
    encoding = request.META.get("HTTP_CONTENT_ENCODING", "identity")
    if length and length.strip().isdigit() and int(length) > JSON_BODY_LIMIT_BYTES and \
            encoding.strip().lower() in ("", "identity"):
        raise too_large()
    raw = request.body
    if len(raw) > JSON_BODY_LIMIT_BYTES:
        raise too_large()
    if not raw:
        return {}, b""
    data = _inflate(raw, encoding)
    if not data:
        return {}, raw
    return decode_json_bytes(data, request.META.get("CONTENT_TYPE", "")), raw
