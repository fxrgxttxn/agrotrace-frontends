"""BR-08 `recallTaskDueAt` (contracts/rules/vectors/BR-08.json): a recall task is due exactly 24 hours after its recall
opened, time of day and milliseconds kept, no business-day skip — `domain.dates.recall_task_due_at`, also with the
process in Europe/Moscow."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone

import pytest

from agrotrace.core import config
from agrotrace.core.render import iso
from agrotrace.domain.dates import recall_task_due_at

DOC = json.loads((config.ROOT / "contracts" / "rules" / "vectors" / "BR-08.json").read_text("utf-8"))
CASES = [pytest.param(c["input"], c["expected"], id=c["name"]) for c in DOC["cases"]]


@pytest.fixture(params=["UTC", "Europe/Moscow"])
def process_tz(request, monkeypatch):
    monkeypatch.setenv("TZ", request.param)
    time.tzset()
    yield request.param
    monkeypatch.undo()
    time.tzset()


def test_the_vector_file_is_recall_task_due_at():
    assert DOC["fn"] == "recallTaskDueAt" and len(CASES) > 5


@pytest.mark.parametrize(("given", "expected"), CASES)
def test_vector(process_tz, given, expected):
    opened = datetime.fromisoformat(given["openedAt"].replace("Z", "+00:00"))
    assert {"dueAt": iso(recall_task_due_at(opened))} == expected


def test_exactly_24_hours_across_a_dst_change_of_the_process_zone(process_tz):
    # 2026-03-29 is the European DST switch; Moscow has none — either way the due moment is 24 h of real time.
    opened = datetime(2026, 3, 28, 23, 30, tzinfo=timezone(timedelta(hours=1)))
    due = recall_task_due_at(opened)
    assert due - opened == timedelta(hours=24)
    assert due.utcoffset() == timedelta(0)


def test_a_naive_instant_is_refused():
    with pytest.raises(ValueError):
        recall_task_due_at(datetime(2026, 9, 10, 9, 0))


def test_microseconds_are_kept():
    opened = datetime(2026, 9, 10, 14, 23, 45, 123_456, tzinfo=UTC)
    assert recall_task_due_at(opened) == datetime(2026, 9, 11, 14, 23, 45, 123_456, tzinfo=UTC)
