"""Request body of POST /processing — the port of packages/validation/src/processing.ts (ProcessingRequestSchema): a
repeated input `batchId` is a schema error (contract step 1, `inputs[i].batchId validation.duplicate`); products of
the outputs may repeat.

One deliberate difference from Zod `noDuplicate` (Ruling Q15): a valid uuid in another letter case is the same batch,
so valid uuids are compared case-insensitively. Express compares the raw strings, so `abc…` and `ABC…` pass its step 1
and its transaction then fails on the `batch_links` unique key (500); here they are the step-1 duplicate the contract
describes. Any other string (already `validation.uuid`) is compared as is, exactly as Zod does, so the 400 bodies for
malformed ids stay those of Express (Task 8 review M1)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agrotrace.core.validation import MISSING, ContractSerializer, ListOf, Mass, Path, Uuid, same_value_zero
from agrotrace.core.views import is_uuid


def _key(v: Any) -> Any:
    return v.lower() if is_uuid(v) else v


def no_duplicate_id(field: str) -> Callable[[list, Callable[[Path, str], None]], None]:
    """superRefine: every repeated element (not the first) gets `validation.duplicate` at `[i].field`; valid uuids are
    compared without letter case, everything else with SameValueZero (core.validation.no_duplicate)."""

    def check(items: list, add: Callable[[Path, str], None]) -> None:
        seen: list[Any] = []
        for i, item in enumerate(items):
            v = _key(item.get(field, MISSING) if isinstance(item, dict) else MISSING)
            if any(same_value_zero(v, s) for s in seen):
                add((i, field), "validation.duplicate")
            seen.append(v)

    return check


class ProcessingInput(ContractSerializer):
    batchId = Uuid()  # noqa: N815
    massUsedKg = Mass()  # noqa: N815


class ProcessingOutput(ContractSerializer):
    productId = Uuid()  # noqa: N815
    massKg = Mass()  # noqa: N815


class ProcessingRequest(ContractSerializer):
    inputs = ListOf(ProcessingInput(), 1, 50).super_refine(no_duplicate_id("batchId"))
    outputs = ListOf(ProcessingOutput(), 1, 20)
