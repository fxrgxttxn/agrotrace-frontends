"""Request bodies of /recalls and /recall-tasks/* — the port of packages/validation/src/recalls.ts (RecallCreateSchema,
RecallTaskConfirmSchema)."""

from __future__ import annotations

from agrotrace.core.validation import Bool, ContractSerializer, String, Uuid


class RecallCreate(ContractSerializer):
    sourceBatchId = Uuid()  # noqa: N815
    reason = String(1, 1000, r"\S")
    blockUpstream = Bool()  # noqa: N815


class RecallTaskConfirm(ContractSerializer):
    """Optional at the operation level; when sent it must be `{}` (no body = `{}`)."""
