"""scheduler.runner.guarded_tick on agrotrace_test_django: the session advisory lock gates the tick, is released
before the connection returns to the pool, and one job's ticks never overlap."""

import threading
import time

from django.db import connection

from agrotrace.core import sql
from agrotrace.scheduler.runner import advisory_key, guarded_tick

LOCKED = "SELECT pg_try_advisory_lock(hashtext(%s))"
UNLOCK = "SELECT pg_advisory_unlock(hashtext(%s))"


def test_a_tick_is_skipped_while_another_session_holds_the_lock(db, other_session):
    ran = []
    key = advisory_key("test-job")
    assert other_session.execute(LOCKED, [key]).fetchone()[0] is True
    try:
        assert guarded_tick("test-job", lambda: ran.append(1) or 1) is False
        assert ran == []
    finally:
        other_session.execute(UNLOCK, [key])
    assert guarded_tick("test-job", lambda: ran.append(1) or 1) is True
    assert ran == [1]


def test_the_lock_is_released_before_the_connection_goes_back_to_the_pool(db, other_session):
    key = advisory_key("test-job-2")
    seen = {}

    def run():
        # Inside the tick: this session holds the lock, so another one cannot take it; the tick's own queries run
        # on the same connection.
        seen["held_elsewhere"] = other_session.execute(LOCKED, [key]).fetchone()[0]
        seen["backend_pid"] = sql.scalar("SELECT pg_backend_pid()")
        return 0

    assert guarded_tick("test-job-2", run) is True
    assert seen["held_elsewhere"] is False
    assert connection.connection is None  # handed back to the pool
    assert other_session.execute(LOCKED, [key]).fetchone()[0] is True  # free again
    other_session.execute(UNLOCK, [key])
    locks = other_session.execute(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = %s", [seen["backend_pid"]]
    ).fetchone()[0]
    assert locks == 0  # the pooled session keeps no advisory lock


def _two_idle_connections_in_the_pool():
    """Checks out two pool connections at once and returns both: the pool now rotates between ≥ 2 idle sessions,
    so a statement that is not pinned would land on another session (psycopg_pool hands idle ones out FIFO)."""
    barrier = threading.Barrier(2)

    def hold():
        with sql.pinned():
            sql.scalar("SELECT 1")
            barrier.wait(5)
        sql.release()

    threads = [threading.Thread(target=hold) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)


def test_the_tick_runs_on_the_session_that_holds_the_lock(db, other_session):
    """N2: whatever the pool's state, `run()` sees the same backend pid that holds the advisory lock."""
    _two_idle_connections_in_the_pool()
    seen = {}

    def run():
        seen["pid"] = sql.scalar("SELECT pg_backend_pid()")
        seen["holders"] = [r[0] for r in other_session.execute(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted").fetchall()]
        seen["pid_again"] = sql.scalar("SELECT pg_backend_pid()")
        return 0

    assert guarded_tick("test-job-pid", run) is True
    assert seen["pid"] in seen["holders"] and seen["pid_again"] == seen["pid"]


def test_a_failing_tick_is_logged_and_the_next_one_runs(db):
    def boom():
        raise RuntimeError("tick failed")

    assert guarded_tick("test-job-3", boom) is False
    assert guarded_tick("test-job-3", lambda: 0) is True


def test_ticks_of_one_job_do_not_overlap(db):
    started = threading.Event()
    results = {}

    def slow():
        started.set()
        time.sleep(0.5)
        return 1

    t = threading.Thread(target=lambda: results.setdefault("first", guarded_tick("test-job-4", slow)))
    t.start()
    started.wait(5)
    results["second"] = guarded_tick("test-job-4", lambda: 1)
    t.join(5)
    assert results == {"first": True, "second": False}
