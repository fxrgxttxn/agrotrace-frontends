"""Request bodies of /complaints/* and createPublicComplaint — the port of packages/validation/src/complaints.ts
(PublicComplaintRequestSchema, ComplaintReviewRequestSchema, ComplaintDecisionSchema) and of `decisionRules` of
backend-express/src/modules/complaints/service.ts.

ComplaintDecision is a Zod `discriminatedUnion('decision', …)`: a body that is not an object → `_root
validation.type`; a `decision` that names no variant (absent, not a string, unknown) → `decision validation.enum` and
nothing else of the schema; else the variant's strict object. The body rules then win per field (P19/P44: no
`decision` → `validation.required`; `labOrgId` only with LAB_TEST, `blockUpstream` only with RECALL →
`validation.notAllowed`; LAB_TEST without `labOrgId` → `validation.required`)."""

from __future__ import annotations

from typing import Any

from agrotrace.core.problem import validation_problem
from agrotrace.core.validation import Bool, ContractSerializer, Literal, String, Uuid


class PublicComplaintRequest(ContractSerializer):
    text = String(10, 2000, r"\S")
    contact = String(1, 255, r"\S").optional()
    altcha = String(1, 4096)


class ComplaintReviewRequest(ContractSerializer):
    """Optional at the operation level; when sent it must be `{}`."""


def _comment():
    return String(1, 1000, r"\S")


class RejectDecision(ContractSerializer):
    decision = Literal("REJECT")
    comment = _comment()


class LabTestDecision(ContractSerializer):
    decision = Literal("LAB_TEST")
    comment = _comment()
    labOrgId = Uuid()  # noqa: N815


class RecallDecision(ContractSerializer):
    decision = Literal("RECALL")
    comment = _comment()
    blockUpstream = Bool().default(False)  # noqa: N815


_VARIANTS: dict[str, type[ContractSerializer]] = {
    "REJECT": RejectDecision, "LAB_TEST": LabTestDecision, "RECALL": RecallDecision}


def _schema_errors(raw: Any) -> tuple[dict[str, Any] | None, dict[str, list[str]]]:
    if not isinstance(raw, dict):
        return None, {"_root": ["validation.type"]}
    variant = _VARIANTS.get(raw["decision"]) if isinstance(raw.get("decision"), str) else None
    if variant is None:
        return None, {"decision": ["validation.enum"]}
    ok, value, errors = variant.validate(raw)
    return (value if ok else None), errors


def _rules(raw: Any) -> dict[str, list[str]]:
    errors: dict[str, list[str]] = {}
    if not isinstance(raw, dict):
        return errors
    if "decision" not in raw:
        errors["decision"] = ["validation.required"]
    decision = raw.get("decision")
    if not isinstance(decision, str):
        return errors
    if "labOrgId" in raw and decision != "LAB_TEST":
        errors["labOrgId"] = ["validation.notAllowed"]
    if "blockUpstream" in raw and decision != "RECALL":
        errors["blockUpstream"] = ["validation.notAllowed"]
    if decision == "LAB_TEST" and "labOrgId" not in raw:
        errors["labOrgId"] = ["validation.required"]
    return errors


def parse_decision(raw: Any) -> dict[str, Any]:
    """The decision body, or 400 with the schema's errors overridden per field by the body rules."""
    rules = _rules(raw)
    value, errors = _schema_errors(raw)
    if errors:
        raise validation_problem({**errors, **rules})
    if rules:
        raise validation_problem(rules)
    assert value is not None
    return value
