"""Request bodies of /me/* — the port of packages/validation/src/profile.ts (MeUpdate, ChannelsUpdate)."""

from __future__ import annotations

from agrotrace.core.validation import Bool, ContractSerializer, NameString, Str, _regex


class MeUpdate(ContractSerializer):
    min_properties = True
    fullName = NameString().optional()  # noqa: N815
    phone = Str([(_regex(r"^\+[1-9]\d{6,14}$"), "validation.phone.format")]).nullable().optional()


class ChannelsUpdate(ContractSerializer):
    email = Bool()
    telegram = Bool()
