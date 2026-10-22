"""Code-point string order (R21, R92), the port of packages/domain/src/strings.ts `compareCodePoints`: the order of
every tie-break and fixed order of the contract — PostgreSQL `COLLATE "C"`, UTF-8 byte order. Python's `str`
comparison already compares code points (JavaScript's `<` compares UTF-16 units, hence the TS helper)."""

from __future__ import annotations


def compare_code_points(a: str, b: str) -> int:
    """-1, 0 or 1."""
    return (a > b) - (a < b)
