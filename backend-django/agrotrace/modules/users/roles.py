"""The one role of each organization type (UserInvite / UserPatch: FARM→FARMER, …, PLATFORM→ADMIN; R37), the port
of backend-express/src/modules/users/roles.ts."""

from __future__ import annotations

from collections.abc import Sequence

ROLE_OF_TYPE: dict[str, str] = {
    "FARM": "FARMER",
    "PROCESSOR": "PROCESSOR",
    "LAB": "LAB",
    "RETAILER": "RETAILER",
    "AUTHORITY": "INSPECTOR",
    "PLATFORM": "ADMIN",
}

#: The `roles` dictionary order (by id).
ROLE_ORDER = ("FARMER", "PROCESSOR", "LAB", "RETAILER", "INSPECTOR", "ADMIN")


def roles_fit_type(roles: Sequence[str], org_type: str) -> bool:
    """Roles are valid for an organization of `org_type` only as exactly its one role."""
    return len(roles) == 1 and roles[0] == ROLE_OF_TYPE.get(org_type)
