"""Request bodies of /batches/* — the port of packages/validation/src/batches.ts (BatchCreate, QrRequest)."""

from __future__ import annotations

from agrotrace.core.validation import ContractSerializer, IsoDateTime, Mass, Uuid


class BatchCreate(ContractSerializer):
    fieldId = Uuid()  # noqa: N815
    productId = Uuid()  # noqa: N815
    massKg = Mass()  # noqa: N815
    harvestedAt = IsoDateTime()  # noqa: N815


class QrRequest(ContractSerializer):
    """The optional body of createBatchQr: absent or exactly `{}`."""
