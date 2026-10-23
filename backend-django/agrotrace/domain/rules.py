"""Business rules of @agrotrace/domain (packages/domain/src/rules.ts): the BR-03 risk model, the public batch code, BR-01
(waiting period), BR-04 (mass balance), BR-05 (processing input) and BR-07 (discrepancy); the state machine is
re-exported from domain.state_machine; BR-02 (lab conclusion), BR-09 (trust rating), BR-10 (recall closing). Vectors:
contracts/rules/vectors (tests/test_domain_vectors.py)."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from agrotrace.core import config
from agrotrace.domain.dates import add_days_to_date, utc_date
from agrotrace.domain.decimal import (
    compare_decimal_strings,
    kg_to_grams,
    mass_total,
    percent_to_basis_points,
    ratio_percent2,
)
from agrotrace.domain.state_machine import available_actions, can_transition
from agrotrace.domain.strings import compare_code_points

__all__ = ["available_actions", "batch_code", "can_transition", "can_use_as_input", "check_discrepancy",
           "check_mass_balance", "check_waiting_period", "conclude_lab_test", "next_trust_rating", "risk_model",
           "sample_bucket", "should_close_recall"]

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


def check_mass_balance(inputs: list[dict], outputs: list[dict]) -> dict:
    """BR-04 `checkMassBalance`, exactly in integer grams: `allowed` = Σ floor(g_i × (10000 − bp_i) / 10000), the
    fractional gram dropped per input (bp = lossNormPercent × 100); ok when Σ outputs ≤ allowed. Inputs are checked
    before outputs, so both empty is NO_INPUTS (R23). Totals are `MassTotal` strings (R50). Never a float."""
    if not inputs:
        return {"error": "NO_INPUTS"}
    if not outputs:
        return {"error": "NO_OUTPUTS"}
    total_in = allowed = total_out = 0
    for x in inputs:
        g = kg_to_grams(x["massUsedKg"])
        total_in += g
        allowed += g * (10000 - percent_to_basis_points(x["lossNormPercent"])) // 10000
    for o in outputs:
        total_out += kg_to_grams(o["massKg"])
    return {"ok": total_out <= allowed, "inputKg": mass_total(total_in), "allowedKg": mass_total(allowed),
            "outputKg": mass_total(total_out)}


def can_use_as_input(status: str) -> dict:
    """BR-05 `canUseAsInput`: only Approved or Accepted batches are processing inputs (R20)."""
    return {"allowed": status in ("Approved", "Accepted")}


def conclude_lab_test(results: list[dict]) -> dict:
    """BR-02 `concludeLabTest`: FAIL when any indicator's value is strictly greater than its norm (`maxValue`; null — not
    normalized, never a failure), else PASS; `exceeded` lists the failing indicators in input order. Exact decimal
    comparison of the strings (domain.decimal), never a float. No results → `{"error": "NO_RESULTS"}`."""
    if not results:
        return {"error": "NO_RESULTS"}
    exceeded = [r["indicatorId"] for r in results
                if r["maxValue"] is not None and compare_decimal_strings(r["value"], r["maxValue"]) > 0]
    return {"conclusion": "FAIL" if exceeded else "PASS", "exceeded": exceeded}


def should_close_recall(task_statuses: list[str]) -> bool:
    """BR-10 `shouldCloseRecall`: a recall closes when every task is CONFIRMED — vacuously for a recall without tasks."""
    return all(s == "CONFIRMED" for s in task_statuses)


#: contracts/rules/trust-rating.json — `initial`, bounds `min`/`max`, `deltas` per rating event (BR-09).
TRUST_RATING: dict = json.loads((config.ROOT / "contracts" / "rules" / "trust-rating.json").read_text("utf-8"))

RatingEvent = Literal["LAB_PASS", "LAB_FAIL", "RECALL_SOURCE"]


def next_trust_rating(current: int, event: str) -> int:
    """BR-09 `nextTrustRating`: `current` + the event's delta clamped to [min, max] — integers throughout (the
    rating column and the deltas are integers, so `Math.round` of the TS port is the identity); an unknown event is a
    KeyError."""
    tr = TRUST_RATING
    return min(tr["max"], max(tr["min"], int(current) + int(tr["deltas"][event])))
