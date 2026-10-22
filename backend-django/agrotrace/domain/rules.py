"""Business rules of @agrotrace/domain (packages/domain/src/rules.ts): the BR-03 risk model, the public batch code, BR-01
(waiting period) and BR-07 (discrepancy); the state machine is re-exported from domain.state_machine. Later tasks add
their rules (BR-02/04/05/08/09/10) here. Vectors: contracts/rules/vectors (tests/test_domain_vectors.py)."""

from __future__ import annotations

import hashlib
from typing import Literal

from agrotrace.domain.dates import add_days_to_date, utc_date
from agrotrace.domain.decimal import kg_to_grams, ratio_percent2
from agrotrace.domain.state_machine import available_actions, can_transition
from agrotrace.domain.strings import compare_code_points

__all__ = ["available_actions", "batch_code", "can_transition", "check_discrepancy", "check_waiting_period", "risk_model",
           "sample_bucket"]

RiskReason = Literal["NEW_FARM", "LOW_RATING", "RECENT_PESTICIDE", "SAMPLED", "NONE"]


def sample_bucket(public_code: str) -> int:
    """sha256(utf-8 publicCode) → the first 4 bytes as a big-endian uint32, mod 100."""
    return int.from_bytes(hashlib.sha256(public_code.encode("utf-8")).digest()[:4], "big") % 100


def risk_model(*, public_code: str, farm_batch_count: int, trust_rating: float,
               pesticide_treatments_last_30_days: int) -> tuple[bool, RiskReason]:
    """BR-03 `requiresLabTest`, checked in order: NEW_FARM (< 5 batches), LOW_RATING (< 70), RECENT_PESTICIDE (> 0),
    SAMPLED (the deterministic 20 % sample by the code's hash), else NONE."""
    if farm_batch_count < 5:
        return True, "NEW_FARM"
    if trust_rating < 70:
        return True, "LOW_RATING"
    if pesticide_treatments_last_30_days > 0:
        return True, "RECENT_PESTICIDE"
    if sample_bucket(public_code) < 20:
        return True, "SAMPLED"
    return False, "NONE"


def batch_code(year: int, n: int) -> str:
    """`formatBatchCode`: AT-{year}-{seq}, seq zero-padded to at least 6 digits (never truncated)."""
    return f"AT-{year}-{n:06d}"


def check_waiting_period(ship_date: str, treatments: list[dict]) -> dict:
    """BR-01 `checkWaitingPeriod`: every treatment (`substance`, `appliedAt` ISO instant, `waitingPeriodDays`) blocks
    until UTC-date(appliedAt) + waitingPeriodDays; shipment is allowed iff `ship_date` ≥ until for all. Otherwise the
    latest `until` is reported, a tie by the smallest substance name in code-point order (R21)."""
    worst: dict | None = None
    for t in treatments:
        until = add_days_to_date(utc_date(t["appliedAt"]), t["waitingPeriodDays"])
        if ship_date >= until:
            continue
        if (worst is None or until > worst["until"]
                or (until == worst["until"] and compare_code_points(t["substance"], worst["substance"]) < 0)):
            worst = {"until": until, "substance": t["substance"]}
    return {"ok": False, **worst} if worst else {"ok": True}


def check_discrepancy(declared_kg: str, actual_kg: str) -> dict:
    """BR-07 `checkDiscrepancy`: `{percent: "N.NN", actRequired}` — percent rounded half up, actRequired exactly in
    grams (|actual − declared| × 100 > 2 × declared); declared 0 → `{error: "DECLARED_ZERO"}` (R22)."""
    d = kg_to_grams(declared_kg)
    if d == 0:
        return {"error": "DECLARED_ZERO"}
    a = kg_to_grams(actual_kg)
    diff = abs(a - d)
    return {"percent": ratio_percent2(diff, d), "actRequired": diff * 100 > 2 * d}
