"""The shared rule vectors (contracts/rules/vectors/*.json, contracts/rules/state-machine.json) run against the Python
port of @agrotrace/domain. One runner: each vector file names its TS function (`fn`); RUNNERS maps it to the port.
Tasks 7–11 add their files and functions here."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any

import pytest

from agrotrace.core import config
from agrotrace.core.render import iso
from agrotrace.domain import dates, rules, state_machine

VECTORS = config.ROOT / "contracts" / "rules" / "vectors"


def _risk(i: dict[str, Any]) -> dict[str, Any]:
    required, reason = rules.risk_model(public_code=i["publicCode"], farm_batch_count=i["farmBatchCount"],
                                        trust_rating=i["trustRating"],
                                        pesticide_treatments_last_30_days=i["pesticideTreatmentsLast30Days"])
    return {"required": required, "reason": reason}


def _working_days(i: dict[str, Any]) -> dict[str, Any]:
    start = datetime.fromisoformat(i["from"].replace("Z", "+00:00"))
    return {"result": iso(dates.add_working_days(start, i["days"]))}


RUNNERS: dict[str, tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    "batch-code.json": ("formatBatchCode", lambda i: {"code": rules.batch_code(i["year"], i["seq"])}),
    "BR-03.json": ("requiresLabTest", _risk),
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
