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
