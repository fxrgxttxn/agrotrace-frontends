"""
`If-Match` (components/parameters.yaml#/IfMatch): the entity's current `version` as a bare integer, required. Errors
go under `errors["If-Match"]`: missing/empty → validation.required, not `^\\d{1,10}$` → validation.type, below 1 →
validation.min; an operation with a body reports them in the same 400 as the body's errors (P36). The comparison is a
compare-and-set against the LOCKED row (R47): `check_version` inside the transaction.
"""

from __future__ import annotations

from agrotrace.core.patterns import ecma
from agrotrace.core.problem import AppProblem, validation_problem

IF_MATCH = "If-Match"
_DIGITS = ecma(r"^\d{1,10}$")


def read_if_match(request) -> tuple[int | None, dict[str, list[str]]]:
    """(version, {}) or (None, errors) — not raised, for merging with the body's errors."""
    raw = request.META.get("HTTP_IF_MATCH")
    if raw is None or raw == "":
        return None, {IF_MATCH: ["validation.required"]}
    if not _DIGITS.search(raw):
        return None, {IF_MATCH: ["validation.type"]}
    n = int(raw)
    if n < 1:
        return None, {IF_MATCH: ["validation.min"]}
    return n, {}


def if_match_version(request) -> int:
    version, errors = read_if_match(request)
    if errors:
        raise validation_problem(errors)
    return version  # type: ignore[return-value]


def check_version(expected: int, current: int) -> None:
    """409 VERSION_CONFLICT `{currentVersion}` when the locked row's version differs from If-Match."""
    if expected != current:
        raise AppProblem(409, "VERSION_CONFLICT", params={"currentVersion": current})
