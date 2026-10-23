"""R24 `addWorkingDays` (contracts/rules/vectors/working-days.json; the deferred M2 of Express Tasks 8–9): every case
against `domain.dates.add_working_days`, in a UTC process and again with the process in Europe/Moscow — the weekday
is always the UTC calendar date's, whatever the process time zone."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone

import pytest

from agrotrace.core import config
from agrotrace.core.render import iso
from agrotrace.domain.dates import add_working_days

DOC = json.loads((config.ROOT / "contracts" / "rules" / "vectors" / "working-days.json").read_text("utf-8"))
CASES = [pytest.param(c["input"], c["expected"], id=c["name"]) for c in DOC["cases"]]


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@pytest.fixture(params=["UTC", "Europe/Moscow"])
def process_tz(request, monkeypatch):
    monkeypatch.setenv("TZ", request.param)
    time.tzset()
    yield request.param
    monkeypatch.undo()
    time.tzset()


def test_the_vector_file_is_add_working_days():
    assert DOC["fn"] == "addWorkingDays" and len(CASES) > 10


@pytest.mark.parametrize(("given", "expected"), CASES)
def test_vector(process_tz, given, expected):
    assert time.localtime().tm_zone in ("UTC", "MSK")
    out = add_working_days(_parse(given["from"]), given["days"])
    assert out.tzinfo is not None
    assert {"result": iso(out)} == expected


def test_an_instant_given_in_another_zone_counts_by_its_utc_date(process_tz):
    # Saturday 01:30 in Moscow is Friday 22:30 UTC: one working day later is Monday 22:30 UTC, not Tuesday.
    msk = timezone(timedelta(hours=3))
    out = add_working_days(datetime(2026, 9, 12, 1, 30, tzinfo=msk), 1)
    assert iso(out) == "2026-09-14T22:30:00.000Z"
    assert out.utcoffset() == timedelta(0)


def test_a_naive_instant_is_refused():
    with pytest.raises(ValueError):
        add_working_days(datetime(2026, 9, 10, 9, 0), 1)


def test_microseconds_are_kept():
    start = datetime(2026, 9, 10, 23, 59, 59, 999_999, tzinfo=UTC)
    assert add_working_days(start, 1) == datetime(2026, 9, 11, 23, 59, 59, 999_999, tzinfo=UTC)
