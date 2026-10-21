"""
Wire formats shared by every response: JSON as Express writes it (compact, UTF-8 without `\\u` escapes, never
NaN/Infinity), instants as `Date.toISOString()` (UTC, milliseconds truncated, `Z`, P38) and masses as decimal strings
with exactly three digits (`^\\d+\\.\\d{3}$`).
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any


def iso(dt: datetime) -> str:
    """`2026-09-24T08:30:00.123Z` — an aware datetime in UTC with milliseconds (truncated, like Date.toISOString)."""
    if dt.tzinfo is None:
        raise ValueError("iso(): naive datetime")
    u = dt.astimezone(UTC)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def iso_or_null(dt: datetime | None) -> str | None:
    return None if dt is None else iso(dt)


def mass(value: Decimal | int | str) -> str:
    """A mass as the contract writes it: three decimals (`12.5` → `"12.500"`)."""
    d = value if isinstance(value, Decimal) else Decimal(str(value))
    return str(d.quantize(Decimal("0.001"), rounding=ROUND_DOWN))


def _default(o: Any) -> Any:
    if isinstance(o, datetime):
        return iso(o)
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=_default)


def json_bytes(obj: Any) -> bytes:
    text = json_dumps(obj)
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        # A lone surrogate (JSON.stringify escapes it as \udXXX): only escaped output is valid UTF-8.
        return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False, default=_default).encode()
