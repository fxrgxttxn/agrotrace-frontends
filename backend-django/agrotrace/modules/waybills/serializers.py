"""Request bodies of /waybills/* — the port of packages/validation/src/waybills.ts (WaybillCreate, WaybillAccept,
WaybillReject). Repeated `batchId`s are reported by the operations themselves (P36), see services.parse_*."""

from __future__ import annotations

from agrotrace.core.validation import ContractSerializer, ListOf, Mass, String, Uuid, no_duplicate


class WaybillCreateItem(ContractSerializer):
    batchId = Uuid()  # noqa: N815
    massDeclaredKg = Mass()  # noqa: N815


class WaybillCreate(ContractSerializer):
    receiverOrgId = Uuid()  # noqa: N815
    items = ListOf(WaybillCreateItem(), 1, 100).super_refine(no_duplicate("batchId"))


class WaybillAcceptItem(ContractSerializer):
    batchId = Uuid()  # noqa: N815
    massActualKg = Mass()  # noqa: N815
    discrepancyAct = String(1, 2000, r"\S").optional()  # noqa: N815


class WaybillAccept(ContractSerializer):
    items = ListOf(WaybillAcceptItem(), 1, 100).super_refine(no_duplicate("batchId"))


class WaybillReject(ContractSerializer):
    reason = String(1, 500, r"\S")
