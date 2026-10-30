"""Exact decimal arithmetic on decimal strings, the port of packages/domain/src/decimal.ts (`compareDecimalStrings`,
`kgToGrams`, `gramsToKg`, `percentToBasisPoints`, `ratioPercent2`) plus `mass_total` for MassTotal sums
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


def grams_to_kg(g: int) -> str:
    """`gramsToKg`: integer grams as a kg string with exactly three decimals (a negative keeps its sign)."""
    if not isinstance(g, int) or isinstance(g, bool):
        raise TypeError(f"grams must be an int: {g!r}")
    a = -g if g < 0 else g
    return f"{'-' if g < 0 else ''}{a // 1000}.{a % 1000:03d}"


_MASS_TOTAL_MAX = 10**18  # MassTotal `^\d{1,15}\.\d{3}$` (R50): below 10^15 kg


def mass_total(g: int) -> str:
    """A sum of masses (BR-04 balance and params, other totals) as the contract's `MassTotal`: non-negative grams with
    at most 15 integer digits of kg; anything else is a programming error (ValueError)."""
    if not isinstance(g, int) or isinstance(g, bool):
        raise TypeError(f"grams must be an int: {g!r}")
    if not 0 <= g < _MASS_TOTAL_MAX:
        raise ValueError(f"not a MassTotal: {g} g")
    return grams_to_kg(g)


_PERCENT = ecma(r"^(\d{1,3})(?:\.(\d{1,2}))?$")


def percent_to_basis_points(s: str) -> int:
    r"""`percentToBasisPoints`: a lossNormPercent (`^\d{1,3}(\.\d{1,2})?$`, R23) as percent × 100."""
    m = _PERCENT.search(s) if isinstance(s, str) else None
    if m is None:
        raise ValueError(f"invalid percent: {s}")
    return int(m.group(1)) * 100 + int((m.group(2) or "").ljust(2, "0"))
