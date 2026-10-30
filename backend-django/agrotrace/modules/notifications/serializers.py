"""The body of markNotificationsRead — the port of `MarkReadRequestSchema` (packages/validation/src/profile.ts), a Zod
3 `z.union([{ids}, {upToSeq}])` of two strict objects:

- `ids` — 1…100 uuids, without repeats (`.refine` → `ids: validation.duplicate`);
- `upToSeq` — an integer ≥ 1.
Union semantics (Zod 3 ZodUnion): the first option that parses wins; else the issues of the FIRST option that failed
only on checks (DIRTY — e.g. `{ids: []}` → `ids: validation.minItems`, `{upToSeq: 0}` → `upToSeq: validation.min`,
`{ids: [...], upToSeq: 1}` → `upToSeq: validation.unknownField`); when every option ABORTED (a missing or mistyped
member, a body that is not an object) → one `_root: validation.invalid` (invalid_union at the body root)."""

from __future__ import annotations

from typing import Any

from agrotrace.core.problem import validation_problem
from agrotrace.core.validation import ABORTED, DIRTY, VALID, ContractSerializer, Ctx, Int, ListOf, Uuid


class MarkReadByIds(ContractSerializer):
    ids = ListOf(Uuid(), 1, 100).refine(lambda arr: len(set(arr)) == len(arr), "validation.duplicate")


class MarkReadUpToSeq(ContractSerializer):
    upToSeq = Int(min=1)  # noqa: N815


OPTIONS: tuple[type[ContractSerializer], ...] = (MarkReadByIds, MarkReadUpToSeq)


def validate_mark_read(raw: Any) -> tuple[int, Any, dict[str, list[str]]]:
    """(status, value, errors) of the union."""
    dirty: tuple[Any, dict[str, list[str]]] | None = None
    for option in OPTIONS:
        ctx = Ctx()
        status, value = option.schema().parse(raw, (), ctx)
        if status == VALID:
            return VALID, value, {}
        if status == DIRTY and dirty is None:
            dirty = (value, ctx.errors)
    if dirty is not None:
        return DIRTY, dirty[0], dirty[1]
    return ABORTED, raw, {"_root": ["validation.invalid"]}


def parse_mark_read(raw: Any) -> dict[str, Any]:
    status, value, errors = validate_mark_read(raw)
    if status != VALID:
        raise validation_problem(errors)
    return value
