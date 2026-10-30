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
    # Not strftime: glibc writes `%Y` of year 1 as `1`; toISOString always has four digits (`0001-01-01T…`).
    return (f"{u.year:04d}-{u.month:02d}-{u.day:02d}T{u.hour:02d}:{u.minute:02d}:{u.second:02d}."
            f"{u.microsecond // 1000:03d}Z")


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


def _shortest(x: float) -> tuple[str, int]:
    """The shortest round-trip digits of a finite x > 0 and n with x = 0.d1d2… × 10^n (ECMA-262 Number::toString's
    k digits s and exponent n). Python's repr is the shortest round-trip form too."""
    from decimal import Decimal as _D

    sign, digits, exp = _D(repr(x)).as_tuple()
    ds = "".join(map(str, digits)).lstrip("0")
    trailing = len(ds) - len(ds.rstrip("0"))
    ds = ds.rstrip("0") or "0"
    # value = int(digits) × 10^exp; after dropping the leading/trailing zeros: int(ds) × 10^(exp + trailing).
    k = len(ds)
    return ds, exp + trailing + k


def js_number_text(x: float | int) -> str:
    """`String(x)` of JavaScript (ECMA-262 Number::toString): `5` → '5', `5.0` → '5', `0.1` → '0.1',
    `1e21` → '1e+21', `1e-7` → '1e-7'."""
    if isinstance(x, bool):
        raise TypeError("js_number_text(bool)")
    if isinstance(x, int):
        if abs(x) < 10**21:
            return str(x)
        x = float(x)
    if x != x:
        return "NaN"
    if x == 0:
        return "0"
    if x < 0:
        return "-" + js_number_text(-x)
    if x == float("inf"):
        return "Infinity"
    s, n = _shortest(x)
    k = len(s)
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    exp = ("+" if e >= 0 else "-") + str(abs(e))
    return (s if k == 1 else s[0] + "." + s[1:]) + "e" + exp


def plain_number_text(x: float | int) -> str:
    """The shortest decimal text that reads back as x, written WITHOUT an exponent (the contract's XLSX numeric cell:
    `2` → '2', `0.1` → '0.1', `1e-7` → '0.0000001', `1e21` → '1000000000000000000000'); backend-express numberText."""
    s = js_number_text(x)
    e = s.find("e")
    if e < 0:
        return s
    neg = s.startswith("-")
    mantissa = s[1 if neg else 0: e]
    exp = int(s[e + 1:])
    dot = mantissa.find(".")
    int_part = mantissa if dot < 0 else mantissa[:dot]
    digits = mantissa if dot < 0 else int_part + mantissa[dot + 1:]
    point = len(int_part) + exp
    if point <= 0:
        body = "0." + "0" * (-point) + digits
    elif point >= len(digits):
        body = digits + "0" * (point - len(digits))
    else:
        body = digits[:point] + "." + digits[point:]
    return ("-" if neg else "") + body
