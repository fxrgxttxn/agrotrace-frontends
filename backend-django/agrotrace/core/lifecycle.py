"""
Process stop of the three Django processes, as backend-express/src/lifecycle.ts `onShutdown`: SHUTDOWN_TIMEOUT_MS is
what an orderly stop may take, and a stop still running 2 s after it ends the process with exit code 1 ("shutdown
timed out"), so a stuck dependency never keeps `docker compose stop` waiting for its own SIGKILL.

- api — uvicorn's `timeout_graceful_shutdown` (agrotrace/serve.py): in-flight requests get SHUTDOWN_TIMEOUT_MS;
- worker — the watchdog starts on Celery's `worker_shutting_down` (celery_app.py);
- beat — the watchdog starts when the scheduler closes (scheduler/beat.py) and is cancelled once it has closed.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable

log = logging.getLogger("agrotrace.lifecycle")

#: Express: `setTimeout(…, timeoutMs + 2000)` before `process.exit(1)`.
GRACE_MS = 2000


def exit_after(timeout_ms: int, *, _exit: Callable[[int], object] = os._exit) -> threading.Timer:
    """Starts the shutdown watchdog: after `timeout_ms` + 2 s the process exits 1. Returns the (daemon) timer; cancel
    it if the stop finished and the process goes on (beat's close)."""

    def expired() -> None:
        log.error("shutdown timed out")
        _exit(1)

    delay_ms = timeout_ms + GRACE_MS
    timer = threading.Timer(delay_ms / 1000, expired)
    timer.daemon = True
    timer.start()
    return timer
