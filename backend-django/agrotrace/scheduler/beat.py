"""
Celery Beat with the ticks executed IN the beat process (plan 3, «Beat»): `celery -A agrotrace.celery_app beat
-S agrotrace.scheduler.beat:InProcessScheduler`. The schedule is Celery's (one entry per registered job, period
SCHEDULER_TICK_MS or the job's own), but an entry that is due is run by `guarded_tick` on a thread of a pool with one
thread per job (a job's tick never overlaps itself) — no tick is ever a broker message (`producer` is None: the
queue carries only the five event types of the envelope). The one job that talks to the broker is `outbox-sweeper`,
which publishes outbox rows (infra/relay.py). Every job also runs once right at start.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from celery.beat import ScheduleEntry, Scheduler

from agrotrace.core import config
from agrotrace.scheduler import jobs
from agrotrace.scheduler.jobs import outbox_sweeper  # noqa: F401  # registers `outbox-sweeper` (5 s)
from agrotrace.scheduler.runner import guarded_tick

log = logging.getLogger("agrotrace.beat")


class InProcessScheduler(Scheduler):
    def __init__(self, *args, **kwargs):
        self._pool = ThreadPoolExecutor(max_workers=len(config.BEAT_JOBS), thread_name_prefix="beat-job")
        super().__init__(*args, **kwargs)

    @property
    def producer(self):  # never connects to the broker
        return None

    def setup_schedule(self) -> None:
        tick_ms = config.get().SCHEDULER_TICK_MS
        self.data = {}
        for job in jobs.REGISTRY.values():
            period = timedelta(milliseconds=job.period_ms or tick_ms)
            self.data[job.name] = ScheduleEntry(name=job.name, task=job.name, schedule=period, app=self.app)
            self.submit(job.name)  # once at start

    def submit(self, name: str) -> None:
        job = jobs.REGISTRY.get(name)
        if job is not None:
            self._pool.submit(guarded_tick, job.name, job.run)

    def apply_entry(self, entry, producer=None):
        self.submit(entry.task)

    def apply_async(self, entry, producer=None, advance=True, **kwargs):
        self.submit(entry.task)

    def close(self) -> None:
        self._pool.shutdown(wait=True, cancel_futures=True)
        super().close()
