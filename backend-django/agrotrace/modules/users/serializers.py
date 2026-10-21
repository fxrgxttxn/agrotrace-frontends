"""Request bodies of /users/* — the port of packages/validation/src/profile.ts (UserInvite, UserPatch)."""

from __future__ import annotations

from agrotrace.core.validation import Bool, ContractSerializer, Email, Enum, ListOf, NameString, Uuid

ROLE_CODES = ("FARMER", "PROCESSOR", "LAB", "RETAILER", "INSPECTOR", "ADMIN")


def Roles():  # noqa: N802
    """At least one RoleCode, no repeats (`validation.duplicate` at `roles`)."""
    return ListOf(Enum(ROLE_CODES), min_items=1).refine(lambda xs: len(set(xs)) == len(xs), "validation.duplicate")


class UserInvite(ContractSerializer):
    email = Email()
    fullName = NameString()  # noqa: N815
    roles = Roles()
    isOrgAdmin = Bool()  # noqa: N815
    organizationId = Uuid().optional()  # noqa: N815


class UserPatch(ContractSerializer):
    min_properties = True
    roles = Roles().optional()
    isOrgAdmin = Bool().optional()  # noqa: N815
    status = Enum(("ACTIVE", "BLOCKED")).optional()
