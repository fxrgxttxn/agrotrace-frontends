"""Request bodies of /admin/* — the port of packages/validation/src/admin.ts."""

from __future__ import annotations

from agrotrace.core.validation import ContractSerializer, Enum, NameString, RegionCode, String


class OrganizationAdminPatch(ContractSerializer):
    min_properties = True
    name = NameString().optional()
    address = String(0, 500, r"\S").nullable().optional()
    regionCode = RegionCode().optional()  # noqa: N815
    status = Enum(("ACTIVE", "REJECTED", "SUSPENDED")).optional()
