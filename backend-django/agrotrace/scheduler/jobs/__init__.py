"""
The beat's jobs (spec 8.2): name → (tick, period). Each later task registers its job here — lab-escalation (Task 9),
recall-task-overdue (Task 10), notification-delivery (Task 12) every SCHEDULER_TICK_MS, outbox-sweeper (Task 6) every
5 s. At most `core.config.BEAT_JOBS` (4: one thread and one connection each, P61).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class Job:
    name: str
    #: One tick; returns how many rows it handled (logged when > 0).
    run: Callable[[], int]
    #: Period in ms; None → SCHEDULER_TICK_MS.
    period_ms: int | None = None


#: Registered jobs (empty until the tasks that own them).
REGISTRY: dict[str, Job] = {}


def register(job: Job) -> Job:
    from agrotrace.core.config import BEAT_JOBS

    if job.name not in BEAT_JOBS:
        raise ValueError(f"{job.name} is not a beat job of the connection budget ({', '.join(BEAT_JOBS)})")
    REGISTRY[job.name] = job
    return job
