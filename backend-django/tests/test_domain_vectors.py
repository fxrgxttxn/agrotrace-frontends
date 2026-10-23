"""The shared rule vectors (contracts/rules/vectors/*.json, contracts/rules/state-machine.json) run against the Python
port of @agrotrace/domain. One runner: each vector file names its TS function (`fn`); RUNNERS maps it to the port.
Tasks 9–11 add their files and functions here. BR-06 has no vector file (a status check, covered over HTTP)."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any

import pytest

from agrotrace.core import config
from agrotrace.core.render import iso
from agrotrace.domain import dates, decimal, rules, state_machine
from agrotrace.domain.idempotency import idempotency_decision

VECTORS = config.ROOT / "contracts" / "rules" / "vectors"


def _risk(i: dict[str, Any]) -> dict[str, Any]:
    required, reason = rules.risk_model(public_code=i["publicCode"], farm_batch_count=i["farmBatchCount"],
                                        trust_rating=i["trustRating"],
                                        pesticide_treatments_last_30_days=i["pesticideTreatmentsLast30Days"])
    return {"required": required, "reason": reason}


def _working_days(i: dict[str, Any]) -> dict[str, Any]:
    start = datetime.fromisoformat(i["from"].replace("Z", "+00:00"))
    return {"result": iso(dates.add_working_days(start, i["days"]))}


def _recall_due(i: dict[str, Any]) -> dict[str, Any]:
    opened = datetime.fromisoformat(i["openedAt"].replace("Z", "+00:00"))
    return {"dueAt": iso(dates.recall_task_due_at(opened))}


def _overdue(i: dict[str, Any]) -> dict[str, Any]:
    return {"overdue": dates.is_overdue(_instant(i["dueAt"]), _instant(i["now"]))}


def _instant(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


RUNNERS: dict[str, tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    "BR-02.json": ("concludeLabTest", lambda i: rules.conclude_lab_test(i["results"])),
    "BR-08.json": ("recallTaskDueAt", _recall_due),
    "BR-08-overdue.json": ("isOverdue", _overdue),
    "BR-09.json": ("nextTrustRating", lambda i: {"rating": rules.next_trust_rating(i["current"], i["event"])}),
    "BR-10.json": ("shouldCloseRecall", lambda i: {"close": rules.should_close_recall(i["taskStatuses"])}),
    "batch-code.json": ("formatBatchCode", lambda i: {"code": rules.batch_code(i["year"], i["seq"])}),
    "BR-01.json": ("checkWaitingPeriod", lambda i: rules.check_waiting_period(i["shipDate"], i["treatments"])),
    "BR-07.json": ("checkDiscrepancy", lambda i: rules.check_discrepancy(i["declaredKg"], i["actualKg"])),
    "BR-11.json": ("idempotencyDecision",
                   lambda i: {"decision": idempotency_decision(i["key"], i["stored"], i["fingerprint"])}),
    "BR-03.json": ("requiresLabTest", _risk),
    "BR-04.json": ("checkMassBalance", lambda i: rules.check_mass_balance(i["inputs"], i["outputs"])),
    "BR-05.json": ("canUseAsInput", lambda i: rules.can_use_as_input(i["status"])),
    "state-machine.json": ("canTransition", lambda i: {"allowed": rules.can_transition(i["from"], i["to"])}),
    "working-days.json": ("addWorkingDays", _working_days),
}


def _cases():
    for file, (fn, run) in RUNNERS.items():
        doc = json.loads((VECTORS / file).read_text("utf-8"))
        assert doc["fn"] == fn, file
        for case in doc["cases"]:
            yield pytest.param(run, case["input"], case["expected"], id=f"{file}: {case['name']}")


@pytest.mark.parametrize(("run", "given", "expected"), list(_cases()))
def test_vector(run, given, expected):
    assert run(given) == expected


def test_every_transition_of_the_machine_file_is_allowed_and_ordered():
    machine = json.loads((config.ROOT / "contracts" / "rules" / "state-machine.json").read_text("utf-8"))
    assert state_machine.batch_statuses() == tuple(machine["statuses"])
    for t in machine["transitions"]:
        assert state_machine.can_transition(t["from"], t["to"])
    for s in machine["statuses"]:
        assert state_machine.available_actions(s) == [
            {"action": t["action"], "to": t["to"]} for t in machine["transitions"] if t["from"] == s]
    pairs = {(t["from"], t["to"]) for t in machine["transitions"]}
    for a in machine["statuses"]:
        for b in machine["statuses"]:
            assert state_machine.can_transition(a, b) == ((a, b) in pairs)
    # The examples of the Batch card: an Approved batch ships or is recalled; Sold has no way out.
    assert [x["action"] for x in state_machine.available_actions("Approved")] == ["ship", "process", "recall"]
    assert state_machine.available_actions("Sold") == []


def test_sample_bucket_matches_the_vector_notes():
    # BR-03.json description: AT-2026-000072 → 0, …000186 → 19, …000279 → 20, …000009 → 99.
    assert [rules.sample_bucket(c) for c in ("AT-2026-000072", "AT-2026-000186", "AT-2026-000279",
                                             "AT-2026-000009")] == [0, 19, 20, 99]


def test_dates_helpers():
    assert dates.add_days_to_date("2026-03-01", -3) == "2026-02-26"
    assert dates.add_days_to_date("2024-02-27", 3) == "2024-03-01"
    assert dates.utc_date("2026-09-10T23:59:59.999Z") == "2026-09-10"


def test_the_waybill_machine_file_is_the_lifecycle():
    machine = json.loads((config.ROOT / "contracts" / "rules" / "waybill-state-machine.json").read_text("utf-8"))
    assert state_machine.waybill_statuses() == ("DRAFT", "SENT", "ACCEPTED", "REJECTED")
    pairs = {(t["from"], t["to"]) for t in machine["transitions"]}
    assert pairs == {("DRAFT", "SENT"), ("DRAFT", "DELETED"), ("SENT", "ACCEPTED"), ("SENT", "REJECTED")}
    for a in (*machine["statuses"], *machine["pseudoStatuses"]):
        for b in (*machine["statuses"], *machine["pseudoStatuses"]):
            assert state_machine.can_waybill_go(a, b) == ((a, b) in pairs)


def test_br01_tie_is_the_smallest_name_by_code_points():
    # R21: equal `until` → the smallest substance name by code points (not UTF-16 units: U+FF5E < U+1F600).
    t = [{"substance": "\U0001F600", "appliedAt": "2026-09-10T00:00:00.000Z", "waitingPeriodDays": 10},
         {"substance": "\uFF5E", "appliedAt": "2026-09-10T12:00:00.000Z", "waitingPeriodDays": 10}]
    assert rules.check_waiting_period("2026-09-15", t) == {"ok": False, "until": "2026-09-20", "substance": "\uFF5E"}


def test_br07_declared_zero_and_half_up():
    assert rules.check_discrepancy("0.000", "1.000") == {"error": "DECLARED_ZERO"}
    assert rules.check_discrepancy("3.000", "3.001") == {"percent": "0.03", "actRequired": False}


def test_kg_to_grams_bounds_r26():
    assert decimal.kg_to_grams("123456789.123") == 123456789123
    assert decimal.kg_to_grams("999999999.999") == 999999999999
    assert decimal.kg_to_grams("12") == 12000 and decimal.kg_to_grams("1.5") == 1500
    for bad in ("1234567890", "1234567890.000", "1.0001", "-1.000", "1.", ".5", "", "1e3", "１.000", "1.000\n"):
        with pytest.raises(ValueError):
            decimal.kg_to_grams(bad)


def test_grams_to_kg_and_mass_total_r50():
    assert decimal.grams_to_kg(0) == "0.000"
    assert decimal.grams_to_kg(1) == "0.001"
    assert decimal.grams_to_kg(123456789123) == "123456789.123"
    assert decimal.grams_to_kg(-1500) == "-1.500"  # as gramsToKg (a difference may be negative)
    # MassTotal `^\d{1,15}\.\d{3}$`: a sum of 50 maximal inputs still fits; a negative or a 16-digit sum does not.
    assert decimal.mass_total(50 * 999999999999) == "49999999999.950"
    assert decimal.mass_total(10**18 - 1) == "999999999999999.999"
    for bad in (-1, 10**18):
        with pytest.raises(ValueError):
            decimal.mass_total(bad)
    with pytest.raises(TypeError):
        decimal.mass_total(1.5)  # type: ignore[arg-type]  # never a float


def test_br04_loss_norm_pattern_r23():
    assert decimal.percent_to_basis_points("5") == 500
    assert decimal.percent_to_basis_points("5.5") == 550
    assert decimal.percent_to_basis_points("100.00") == 10000
    for bad in ("1000", "5.555", "-5", "5.", "", "٥", "5\n"):
        with pytest.raises(ValueError):
            decimal.percent_to_basis_points(bad)
    with pytest.raises(ValueError):
        rules.check_mass_balance([{"massUsedKg": "1.000", "lossNormPercent": "5.555"}], [{"massKg": "1.000"}])
    # Both lists empty → NO_INPUTS first (R23); allowance is floored per input, not on the sum.
    assert rules.check_mass_balance([], []) == {"error": "NO_INPUTS"}
    assert rules.check_mass_balance(
        [{"massUsedKg": "0.001", "lossNormPercent": "1.5"}, {"massUsedKg": "0.001", "lossNormPercent": "1.5"}],
        [{"massKg": "0.001"}],
    ) == {"ok": False, "inputKg": "0.002", "allowedKg": "0.000", "outputKg": "0.001"}


def test_br02_is_strictly_greater_and_decimal():
    """BR-02: equal is not exceeded (strict `>`), whatever the scale; the comparison is exact, never a float."""
    one = lambda v, m: rules.conclude_lab_test([{"indicatorId": "x", "value": v, "maxValue": m}])  # noqa: E731
    assert one("0.500000", "0.5") == {"conclusion": "PASS", "exceeded": []}
    assert one("10", "10.000000") == {"conclusion": "PASS", "exceeded": []}
    assert one("10.000001", "10") == {"conclusion": "FAIL", "exceeded": ["x"]}
    # 0.1 + 0.2 style traps: exact decimals.
    assert one("0.300000", "0.3") == {"conclusion": "PASS", "exceeded": []}
    assert one("99999999.999999", "99999999.999998") == {"conclusion": "FAIL", "exceeded": ["x"]}
    assert rules.conclude_lab_test([]) == {"error": "NO_RESULTS"}


def test_every_vector_file_has_a_runner():
    # treatment-edit.json runs in tests/test_treatment_window.py.
    assert sorted(p.name for p in VECTORS.glob("*.json")) == sorted([*RUNNERS, "treatment-edit.json"])


def test_br09_follows_trust_rating_json():
    """BR-09 reads contracts/rules/trust-rating.json (initial, bounds, deltas) — never constants of its own."""
    tr = json.loads((config.ROOT / "contracts" / "rules" / "trust-rating.json").read_text("utf-8"))
    assert rules.TRUST_RATING == tr
    for event, delta in tr["deltas"].items():
        assert rules.next_trust_rating(50, event) == 50 + delta
    assert rules.next_trust_rating(tr["max"], "LAB_PASS") == tr["max"]
    assert rules.next_trust_rating(tr["min"], "LAB_FAIL") == tr["min"]
    with pytest.raises(KeyError):
        rules.next_trust_rating(50, "OTHER")
