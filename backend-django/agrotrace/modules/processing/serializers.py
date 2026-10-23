"""Request body of POST /processing — the port of packages/validation/src/processing.ts (ProcessingRequestSchema): a
repeated input `batchId` is a schema error (contract step 1, `inputs[i].batchId validation.duplicate`); products of
the outputs may repeat.

One deliberate difference from Zod `noDuplicate`: ids are compared case-insensitively (a uuid in another letter case is
the same batch). Express compares the raw strings, so `abc…` and `ABC…` pass its step 1 and its transaction then fails
on the `batch_links` unique key (500); here they are the step-1 duplicate the contract describes."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agrotrace.core.validation import ContractSerializer, ListOf, Mass, Path, Uuid


def no_duplicate_id(field: str) -> Callable[[list, Callable[[Path, str], None]], None]:
    """superRefine: every repeated id (not the first, letter case ignored) gets `validation.duplicate` at `[i].field`."""

    def check(items: list, add: Callable[[Path, str], None]) -> None:
        seen: set[Any] = set()
        for i, item in enumerate(items):
            v = item.get(field) if isinstance(item, dict) else None
            if not isinstance(v, str):
                continue
            if v.lower() in seen:
                add((i, field), "validation.duplicate")
            seen.add(v.lower())

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
