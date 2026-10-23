"""Date rules of @agrotrace/domain (packages/domain/src/dates.ts) — instants compared as JavaScript does: at millisecond
precision (`Date.parse` of ISO strings), always in UTC (P43: callers pass the database clock, never the process's)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

DAY = timedelta(days=1)


def epoch_ms(v: str | datetime) -> int:
    """Milliseconds since the epoch, truncated like `Date.toISOString()` / `Date.parse`."""
    if isinstance(v, str):
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if v.tzinfo is None:
        raise ValueError("naive datetime")
    delta = v.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000


def can_edit_treatment(created_at: str | datetime, now: str | datetime) -> bool:
    """FR-PROD-02 (vectors/treatment-edit.json): editable while now − createdAt ≤ 24 h, the boundary inclusive."""
    return epoch_ms(now) - epoch_ms(created_at) <= 86_400_000


def editable_until(created_at: datetime) -> datetime:
    """createdAt + 24 h (the end of the edit window, `Treatment.editableUntil`)."""
    return created_at + DAY


def utc_date(v: str | datetime) -> str:
    """The UTC calendar date `YYYY-MM-DD` of an instant (`utcDate`)."""
    if isinstance(v, str):
        return v[:10]
    return v.astimezone(UTC).date().isoformat()


def add_days_to_date(date: str, days: int) -> str:
    """`addDaysToDate`: a calendar date plus `days` (negative allowed)."""
    from datetime import date as _date

    return (_date.fromisoformat(date) + timedelta(days=days)).isoformat()


def _aware(v: datetime) -> datetime:
    if v.tzinfo is None or v.utcoffset() is None:
        # A naive datetime would be read in the process time zone (TZ=Europe/Moscow on the --tz run): never.
        raise ValueError("naive datetime")
    return v.astimezone(UTC)


def add_working_days(start: datetime, days: int) -> datetime:
    """`addWorkingDays` (R24): N working days (Mon–Fri by the UTC calendar date) after `start`, the time of day kept;
    0 returns `start` unchanged even on a weekend. Holidays are not considered. The result is in UTC whatever the
    process time zone; a naive `start` is refused."""
    d = _aware(start)
    left = days
    while left > 0:
        d += DAY
        if d.weekday() < 5:
            left -= 1
    return d


def recall_task_due_at(opened_at: datetime) -> datetime:
    """`recallTaskDueAt` (BR-08): a recall task is due exactly 24 hours after its recall opened (time of day and
    sub-second part kept, no business-day skip), in UTC; a naive `opened_at` is refused."""
    return _aware(opened_at) + DAY


def is_overdue(due_at: datetime, now: datetime) -> bool:
    """`isOverdue`: now > dueAt, compared as JavaScript compares instants (milliseconds)."""
    return epoch_ms(now) > epoch_ms(due_at)
