"""Request bodies of /dictionaries/* — the port of packages/validation/src/admin.ts (`DictionaryInput`: one schema per
dictionary; a body of another dictionary's schema fails that dictionary's schema)."""

from __future__ import annotations

from agrotrace.core.validation import (
    ContractSerializer,
    DecimalString,
    Enum,
    Int,
    RegionCode,
    Str,
    String,
    Uuid,
    _regex,
)

CATEGORIES = ("GRAIN", "VEGETABLE", "FRUIT", "DAIRY", "MEAT", "OILSEED", "PROCESSED")
SUBSTANCE_TYPES = ("PESTICIDE", "FERTILIZER")


def _utf16_length(s: str) -> int:
    """Zod's `.max()` counts UTF-16 code units."""
    return len(s.encode("utf-16-le")) // 2


class ProductInput(ContractSerializer):
    name = String(1, 160, r"\S")
    category = Enum(CATEGORIES)
    lossNormPercent = Str([(_regex(r"^(100\.00|\d{1,2}\.\d{2})$"), "validation.percent.format")])  # noqa: N815
    # R81: the ФГИС «Меркурий» product code; null — no code. Both string checks run (Zod checks are not fatal).
    mercuryCode = Str([  # noqa: N815
        (lambda s: _utf16_length(s) <= 16, "validation.maxLength"),
        (_regex(r"^\d{2}(\.\d{1,3}){1,3}$"), "validation.mercuryCode.format"),
    ]).nullable().optional()


class SubstanceInput(ContractSerializer):
    name = String(1, 160, r"\S")
    type = Enum(SUBSTANCE_TYPES)
    waitingPeriodDays = Int(0, 3650)  # noqa: N815


class IndicatorInput(ContractSerializer):
    name = String(1, 160, r"\S")
    unit = String(1, 24, r"\S")


class NormInput(ContractSerializer):
    productId = Uuid()  # noqa: N815
    indicatorId = Uuid()  # noqa: N815
    maxValue = DecimalString()  # noqa: N815


class RegionInput(ContractSerializer):
    code = RegionCode()
    name = String(1, 120, r"\S")


INPUTS: dict[str, type[ContractSerializer]] = {
    "products": ProductInput,
    "substances": SubstanceInput,
    "indicators": IndicatorInput,
    "norms": NormInput,
    "regions": RegionInput,
}
