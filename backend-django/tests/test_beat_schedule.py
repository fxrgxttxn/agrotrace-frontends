"""scheduler.beat.InProcessScheduler (plan 3 «Beat», spec 8.2): one Celery Beat entry per registered job with the
period SCHEDULER_TICK_MS (the outbox sweeper: its own 5 s), every job submitted once right at start, and a due entry
run IN the beat process — `apply_async`/`apply_entry` never publish (a fake producer is never touched; the
scheduler's own producer is None). The job set fits the connection budget (P61 / SP4: beat 4 = one per job)."""

from __future__ import annotations

import dataclasses
import threading
import time
from datetime import timedelta

import pytest

from agrotrace.celery_app import app
from agrotrace.core import config
from agrotrace.scheduler import beat, jobs


class FakeProducer:
    def __init__(self):
        self.calls: list[str] = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append(name)

        return record


@pytest.fixture
def tick_1s(monkeypatch):
    monkeypatch.setattr(config, "_config", dataclasses.replace(config.get(), SCHEDULER_TICK_MS=1000))


@pytest.fixture
def ran(monkeypatch):
    """guarded_tick replaced by a recorder (no job touches the DB or the broker here)."""
    seen: list[str] = []
    lock = threading.Lock()

    def record(name, run):
        with lock:
            seen.append(name)
        return True

    monkeypatch.setattr(beat, "guarded_tick", record)
    return seen


def _scheduler() -> beat.InProcessScheduler:
    return beat.InProcessScheduler(app=app)


def _wait_for(ran: list[str], n: int) -> None:
    """The pool runs the submissions on its threads; `close()` cancels any not yet picked up."""
    until = time.monotonic() + 5
    while len(ran) < n and time.monotonic() < until:
        time.sleep(0.01)


def test_the_registered_jobs_are_the_budget_jobs_of_this_task():
    assert set(jobs.REGISTRY) <= set(config.BEAT_JOBS)
    assert {"lab-escalation", "outbox-sweeper"} <= set(jobs.REGISTRY)
    assert len(config.BEAT_JOBS) == 4  # beat-django DJANGO_DB_POOL_MAX 4: one connection per job
    assert jobs.REGISTRY["lab-escalation"].period_ms is None  # SCHEDULER_TICK_MS


def test_scheduler_tick_ms_is_the_period_and_every_job_runs_at_start(tick_1s, ran):
    s = _scheduler()
    try:
        assert set(s.data) == set(jobs.REGISTRY)
        for name, entry in s.data.items():
            want = timedelta(milliseconds=jobs.REGISTRY[name].period_ms or 1000)
            assert entry.schedule.run_every == want, name
        assert s.data["lab-escalation"].schedule.run_every == timedelta(seconds=1)
        assert s.data["outbox-sweeper"].schedule.run_every == timedelta(seconds=5)
        _wait_for(ran, len(jobs.REGISTRY))
    finally:
        s.close()
    assert sorted(ran) == sorted(jobs.REGISTRY)


def test_a_due_entry_runs_in_process_and_never_touches_a_producer(tick_1s, ran):
    s = _scheduler()
    try:
        assert s.producer is None
        fake = FakeProducer()
        entry = s.data["lab-escalation"]
        s.apply_async(entry, producer=fake)
        s.apply_entry(entry, producer=fake)
        _wait_for(ran, len(jobs.REGISTRY) + 2)
    finally:
        s.close()
    assert fake.calls == []
    assert ran.count("lab-escalation") == 3  # start-up + the two due runs


def test_beat_has_one_thread_per_budget_job(tick_1s, ran):
    s = _scheduler()
    try:
        assert s._pool._max_workers == len(config.BEAT_JOBS) == 4
    finally:
        s.close()
