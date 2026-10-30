"""Request bodies of /lab-tests/* — the port of packages/validation/src/lab.ts (LabTestCreateSchema,
LabSampleRequestSchema, LabResultsInputSchema). A repeated `indicatorId` is step 5 of submitLabResults (P36): the
operation defers it (`parse_request_body(..., defer_duplicates=["results"])`)."""

from __future__ import annotations

from agrotrace.core.validation import ContractSerializer, DecimalString, ListOf, Uuid, no_duplicate


class LabTestCreate(ContractSerializer):
    batchId = Uuid()  # noqa: N815
    labOrgId = Uuid()  # noqa: N815


class LabSampleRequest(ContractSerializer):
    """Optional at the operation level; when sent it must be `{}` (no body = `{}`, decision 9 of Express Tasks 8–9)."""


class LabResult(ContractSerializer):
    indicatorId = Uuid()  # noqa: N815
    value = DecimalString()


class LabResultsInput(ContractSerializer):
    results = ListOf(LabResult(), 1, 200).super_refine(no_duplicate("indicatorId"))
