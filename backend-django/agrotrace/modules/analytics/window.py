"""
The analytics window (getDashboard, downloadReport; contracts/openapi/paths/analytics.yaml, reports.yaml), the port of
backend-express/src/modules/analytics/window.ts: UTC dates, inclusive. Default — the last 30 days: `to` = today (UTC,
the snapshot transaction's clock, P43), `from` = `to` − 29; one end given — the other one 29 days from it; `from` >
`to` → `errors.from: [validation.range]` (QueryReader.date_range); longer than 366 days →
`errors.from: [validation.range.tooLong]`. And the read-only snapshot all analytics run in: one transaction
READ ONLY REPEATABLE READ (`snapshot`).

Dates stay `YYYY-MM-DD` strings: the contract's calendar includes year 0000 (QueryReader, like Express), which
`datetime.date` cannot hold, so the day arithmetic is done on proleptic Gregorian day numbers. A computed end beyond
the four-digit calendar (`from=9999-12-31` alone, `to=0000-01-01` alone) is clamped to 9999-12-31 / 0000-01-01:
Express prints `+010000-01` / `-000001-12` there (not a `format: date`), and no row lies beyond either end, so every
number is the same.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from agrotrace.core.params import day_after, day_start
from agrotrace.core.tx import Tx, with_tx

DEFAULT_DAYS = 30
MAX_DAYS = 366
_FIRST = "0000-01-01"
_LAST = "9999-12-31"


def _days(date: str) -> int:
    """Day number of a `YYYY-MM-DD` (proleptic Gregorian, 1970-01-01 = 0; H. Hinnant's days_from_civil)."""
    y, m, d = int(date[:4]), int(date[5:7]), int(date[8:10])
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _date(days: int) -> str:
    """The inverse of `_days`, clamped to the four-digit calendar 0000-01-01 … 9999-12-31."""
    if days < _days(_FIRST):
        return _FIRST
    if days > _days(_LAST):
        return _LAST
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    y = yoe + era * 400 + (m <= 2)
    return f"{y:04d}-{m:02d}-{d:02d}"


def shift(date: str, days: int) -> str:
    return _date(_days(date) + days)


def too_long(frm: str | None, to: str | None) -> bool:
    """True when explicit bounds span more than 366 days (a default or one-sided window never does)."""
    return frm is not None and to is not None and _days(to) - _days(frm) + 1 > MAX_DAYS


def today_of(now: datetime) -> str:
    u = now.astimezone(UTC)
    return f"{u.year:04d}-{u.month:02d}-{u.day:02d}"


def resolve(params: tuple[str | None, str | None], snapshot_now: datetime) -> tuple[str, str]:
    """The applied window (`from`, `to`) of the validated `(from, to)` parameters; today = the UTC date of the
    snapshot's now()."""
    frm, to = params
    if frm is None and to is None:
        t = today_of(snapshot_now)
        return shift(t, 1 - DEFAULT_DAYS), t
    if frm is None:
        return shift(to, 1 - DEFAULT_DAYS), to  # type: ignore[arg-type]
    if to is None:
        return frm, shift(frm, DEFAULT_DAYS - 1)
    return frm, to


@dataclass(frozen=True)
class Window:
    frm: str
    to: str

    def period(self) -> dict[str, str]:
        return {"from": self.frm, "to": self.to}

    def bounds(self) -> tuple[datetime, Any]:
        """Half-open instant bounds [from 00:00Z, to + 1 day 00:00Z) as SQL parameters: the end of 9999-12-31 is
        `'infinity'` (no timestamptz lies after it, as Express's 10000-01-01)."""
        end = day_after(self.to)
        return day_start(self.frm), "infinity" if end is None else end


def snapshot[T](fn: Callable[[Tx, datetime], T]) -> T:
    """Runs `fn(tx, now)` in one READ ONLY REPEATABLE READ transaction with the snapshot's now() (P43: one instant).
    The pool connection goes back as soon as it ends (P61): rendering never holds one."""
    return with_tx(lambda tx: fn(tx, tx.now), isolation="read only repeatable read", retry_once=False)
