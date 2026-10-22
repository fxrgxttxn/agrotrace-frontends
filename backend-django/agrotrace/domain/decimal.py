"""Exact decimal comparison of decimal strings, the port of packages/domain/src/decimal.ts `compareDecimalStrings`
(R59: `5` = `5.00`; never float arithmetic on stored decimals)."""

from __future__ import annotations

from decimal import Decimal

from agrotrace.core.patterns import ecma

_DECIMAL = ecma(r"^(\d+)(?:\.(\d+))?$")


def compare_decimal_strings(a: str | Decimal, b: str | Decimal) -> int:
    r"""-1, 0 or 1 — exact and scale-normalized. Strings must be non-negative decimals (`^\d+(\.\d+)?$`)."""
    da, db = _parse(a), _parse(b)
    return (da > db) - (da < db)


def _parse(v: str | Decimal) -> Decimal:
    if isinstance(v, Decimal):
        return v
    if not _DECIMAL.search(v):
        raise ValueError(f"invalid decimal: {v}")
    return Decimal(v)


_MASS = ecma(r"^\d{1,9}(?:\.\d{1,3})?$")


def kg_to_grams(s: str) -> int:
    """`kgToGrams`: a mass in kg (at most 9 integer and 3 decimal digits) as integer grams."""
    if not _MASS.search(s):
        raise ValueError(f"invalid mass: {s}")
    int_part, _, frac = s.partition(".")
    return int(int_part) * 1000 + int(frac.ljust(3, "0"))


def ratio_percent2(n: int, d: int) -> str:
    """`ratioPercent2`: n/d × 100 rounded half up to 2 decimals, `"N.NN"` (n, d ≥ 0, d > 0)."""
    scaled = (n * 10000 * 2 + d) // (2 * d)
    return f"{scaled // 100}.{scaled % 100:02d}"
