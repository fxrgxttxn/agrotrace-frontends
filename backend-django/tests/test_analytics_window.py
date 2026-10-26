"""The analytics window (modules/analytics/window.py; paths/analytics.yaml): 30 days up to the snapshot's UTC date by
default, one end → the other 29 days from it, > 366 days → `validation.range.tooLong`, scope and window errors in one
400; the four-digit calendar edges (year 0000, 9999-12-31) as the other date filters treat them."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from agrotrace.core.params import QueryReader
from agrotrace.core.problem import AppProblem
from agrotrace.modules.analytics import dashboard
from agrotrace.modules.analytics.window import Window, resolve, shift, too_long
from agrotrace.security.jwt import Principal

LAB = Principal(user_id="u", org_id="o", roles=("LAB",), org_admin=False)


def test_default_is_30_days_up_to_the_snapshot_date_in_utc():
    # 23:30 in Moscow on the 1st is still the 1st in UTC at 20:30; 01:30 MSK on the 2nd is the 1st 22:30 UTC.
    msk = timezone(timedelta(hours=3))
    assert resolve((None, None), datetime(2026, 3, 2, 1, 30, tzinfo=msk)) == ("2026-01-31", "2026-03-01")
    assert resolve((None, None), datetime(2026, 3, 1, 0, 0, tzinfo=UTC)) == ("2026-01-31", "2026-03-01")
    assert resolve((None, None), datetime(2024, 3, 1, 12, 0, tzinfo=UTC)) == ("2024-02-01", "2024-03-01")


def test_one_end_gives_the_other_29_days_from_it():
    now = datetime(2026, 10, 26, tzinfo=UTC)
    assert resolve(("2026-03-01", None), now) == ("2026-03-01", "2026-03-30")
    assert resolve((None, "2026-03-01"), now) == ("2026-01-31", "2026-03-01")
    assert resolve(("2026-03-01", "2026-03-05"), now) == ("2026-03-01", "2026-03-05")


def test_366_days_is_the_limit():
    assert not too_long("2025-03-01", "2026-03-01")  # 366 days
    assert too_long("2025-02-28", "2026-03-01")
    assert not too_long("2024-01-01", "2024-12-31")  # a leap year: 366 days
    assert too_long("2023-12-31", "2024-12-31")
    assert not too_long(None, "2026-03-01") and not too_long("2020-01-01", None)


def test_the_calendar_edges():
    """Year 0000 is a calendar date (as QueryReader / Express); a computed end beyond the four-digit calendar is
    clamped (Express prints `+010000-01`, not a date); 9999-12-31 has no upper instant ('infinity')."""
    now = datetime(2026, 10, 26, tzinfo=UTC)
    assert shift("0000-03-01", -1) == "0000-02-29"  # year 0 is a leap year (proleptic Gregorian)
    assert shift("0001-01-01", -1) == "0000-12-31"
    assert resolve((None, "0001-01-10"), now) == ("0000-12-12", "0001-01-10")
    assert resolve(("9999-12-31", None), now) == ("9999-12-31", "9999-12-31")
    assert resolve((None, "0000-01-01"), now) == ("0000-01-01", "0000-01-01")
    assert too_long("0000-01-01", "0000-12-31") is False and too_long("0000-01-01", "0001-01-01") is True
    start, end = Window("9999-12-20", "9999-12-31").bounds()
    assert start == datetime(9999, 12, 20, tzinfo=UTC) and end == "infinity"
    assert Window("2026-03-01", "2026-03-01").bounds() == (datetime(2026, 3, 1, tzinfo=UTC),
                                                           datetime(2026, 3, 2, tzinfo=UTC))


def _errors(query: dict, p: Principal = LAB) -> dict:
    with pytest.raises(AppProblem) as e:
        dashboard.get_dashboard(p, query)
    assert e.value.status == 400 and e.value.code == "VALIDATION"
    return e.value.errors or {}


def test_scope_and_window_errors_come_in_one_400():
    assert _errors({"scope": "inspector", "from": "2026-02-30"}) == {
        "scope": ["validation.scope.notAllowed"], "from": ["validation.date.format"]}
    assert _errors({"scope": "lab", "from": "2025-02-28", "to": "2026-03-01"}) == {
        "from": ["validation.range.tooLong"]}
    assert _errors({"scope": "lab", "from": "2026-03-02", "to": "2026-03-01"}) == {"from": ["validation.range"]}
    assert _errors({}) == {"scope": ["validation.required"]}
    assert _errors({"scope": "all", "to": "x"}) == {"scope": ["validation.enum"], "to": ["validation.date.format"]}
    admin = Principal(user_id="u", org_id="o", roles=("ADMIN",), org_admin=True)
    assert _errors({"scope": "org"}, admin) == {"scope": ["validation.scope.notAllowed"]}


def test_window_params_reads_the_query_like_the_dashboard():
    q = QueryReader({"from": "2025-02-28", "to": "2026-03-01"})
    assert dashboard.window_params(q) == ("2025-02-28", "2026-03-01")
    assert q.errors == {"from": ["validation.range.tooLong"]}


def test_hours_and_shares():
    assert dashboard.hours(0, 0) is None
    assert dashboard.hours(5400, 1) == "1.50"
    assert dashboard.hours("65700", 1) == "18.25"
    assert dashboard.hours(1, 1) == "0.00" and dashboard.hours(18, 1) == "0.01"  # half up at 0.005 h
    rows = [{"key": "a", "name": "Б", "tested": 3, "failed": 1}, {"key": "b", "name": "А", "tested": 6, "failed": 2},
            {"key": "c", "name": "В", "tested": 300, "failed": 100}, {"key": "d", "name": "Z", "tested": 8, "failed": 8}]
    # 33.33 for three of them: tested desc, then the name; 100.00 first.
    assert [r["key"] for r in dashboard._top_shares(rows)] == ["d", "c", "b", "a"]
    assert dashboard._top_shares(rows)[1]["share"] == "33.33"
