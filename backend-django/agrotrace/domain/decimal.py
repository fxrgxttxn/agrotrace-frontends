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
