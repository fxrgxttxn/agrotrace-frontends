"""
One guarded tick of a beat job (spec 8.2, the port of backend-express/src/scheduler/runner.ts): the tick runs only
while this thread holds the SESSION advisory lock `pg_try_advisory_lock(hashtext('agrotrace.scheduler.<name>'))` —
another scheduler of any backend sharing the DB skips it. The lock and the tick's transactions use the same
connection (the job thread's; one per job, P61); the lock is released in `finally` BEFORE the connection goes back to
the pool (a pooled connection never keeps it — if the unlock itself fails, the physical connection is discarded). A
tick of a job that is still running is not overlapped; a failing tick is logged, and the next one runs as usual.
"""

from __future__ import annotations

import logging
import threading
from collections import defaultdict
from collections.abc import Callable

from django.db import connection, connections

from agrotrace.core import sql

log = logging.getLogger("agrotrace.scheduler")

_running: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)
_guard = threading.Lock()


def _job_lock(name: str) -> threading.Lock:
    with _guard:
        return _running[name]


def advisory_key(name: str) -> str:
    return f"agrotrace.scheduler.{name}"


def guarded_tick(name: str, run: Callable[[], int]) -> bool:
    """True when this call ran the tick; False when the lock was held elsewhere, a tick is running, or it failed."""
    running = _job_lock(name)
    if not running.acquire(blocking=False):
        return False
    try:
        key = advisory_key(name)
        try:
            # The session lock and the tick's transactions stay on one connection (core.sql holder discipline).
            with sql.pinned():
                if not sql.scalar("SELECT pg_try_advisory_lock(hashtext(%s))", [key]):
                    return False
                try:
                    n = run()
                    if n and n > 0:
                        log.info("scheduler job tick", extra={"job": name, "rows": n})
                finally:
                    try:
                        sql.execute("SELECT pg_advisory_unlock(hashtext(%s))", [key])
                    except Exception:
                        # The session would keep the lock: never hand this connection back to the pool.
                        raw = connection.connection
                        if raw is not None:
                            raw.close()
                        raise
            return True
        except Exception as e:
            log.error("scheduler job failed", exc_info=e, extra={"job": name})
            return False
        finally:
            connections.close_all()
    finally:
        running.release()
