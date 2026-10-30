"""Shared date helpers at the limits of `format: date` / `date-time` (review I1, I2 of Tasks 4+5): `iso` writes four
year digits like Date.toISOString; the from/to day bounds match Express's `dayAfter` from 0000-01-01 to 9999-12-31."""

from datetime import UTC, datetime

import pytest

from agrotrace.core.params import day_after, day_start, is_calendar_date, utc_day_bounds
from agrotrace.core.render import iso

EARLIEST = datetime.min.replace(tzinfo=UTC)


@pytest.mark.parametrize(("dt", "text"), [
    (datetime(1, 1, 1, tzinfo=UTC), "0001-01-01T00:00:00.000Z"),
    (datetime(999, 12, 31, 23, 59, 59, 999999, tzinfo=UTC), "0999-12-31T23:59:59.999Z"),
    (datetime(2026, 9, 24, 8, 30, 0, 123456, tzinfo=UTC), "2026-09-24T08:30:00.123Z"),
    (datetime(9999, 12, 31, 23, 59, 59, tzinfo=UTC), "9999-12-31T23:59:59.000Z"),
])
def test_iso_has_four_year_digits(dt, text):
    assert iso(dt) == text


def test_day_bounds_at_the_limits():
    assert is_calendar_date("9999-12-31") and is_calendar_date("0000-01-01")
    assert day_after("9999-12-31") is None  # Express: 10000-01-01, after every instant
    assert day_after("9999-12-30") == datetime(9999, 12, 31, tzinfo=UTC)
    assert day_after("0000-12-31") == datetime(1, 1, 1, tzinfo=UTC)
    assert day_after("0000-06-01") == EARLIEST  # still year 0: before every instant
    assert day_start("0000-01-01") == EARLIEST
    assert day_start("0001-01-01") == datetime(1, 1, 1, tzinfo=UTC)


def test_utc_day_bounds():
    assert utc_day_bounds("a.created_at", None, "9999-12-31") == ([], [])
    assert utc_day_bounds("a.created_at", "2026-01-02", "2026-01-03") == (
        ["a.created_at >= %s", "a.created_at < %s"],
        [datetime(2026, 1, 2, tzinfo=UTC), datetime(2026, 1, 4, tzinfo=UTC)])
    assert utc_day_bounds("t.applied_at", "9999-12-31", None) == (["t.applied_at >= %s"],
                                                                   [datetime(9999, 12, 31, tzinfo=UTC)])
