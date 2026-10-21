"""
Heavy work off the request threads (P18 SVG, P24 XLSX, reports — used from Task 3), the port of
backend-express/src/infra/worker-queue.ts: a child-process engine behind a bounded queue.

- child processes come from `multiprocessing.get_context('forkserver')` (the uvicorn process is multi-threaded, so
  `fork` is unsafe) and run under `RLIMIT_AS = memory_mb` (exceeding it kills the job, never the API, D-M3);
- at most `max_waiting` jobs wait and `max_running` run; an overflow is refused at once (`too-complex`);
- every job has one deadline counted from enqueue, waiting included; a missed deadline or a crash of the engine
  replaces the engine (its process is terminated: the work stops) — `too-complex`;
- a client that goes away (`cancelled()`, by default `core.context.client_gone`, D-I7): a WAITING job is removed and
  never executed (`aborted`); a running one runs to completion and its result is dropped.
"""

from __future__ import annotations

import multiprocessing
import threading
import time
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from typing import Any, Literal

from agrotrace.core.context import client_gone

POLL_S = 0.02


@dataclass(frozen=True)
class Outcome:
    ok: bool
    value: Any = None
    reason: Literal["too-complex", "aborted"] | None = None


def _limit_memory(memory_mb: int) -> None:  # pragma: no cover - runs in the child
    import resource

    limit = memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


class Lane:
    def __init__(self, name: str, *, max_waiting: int, deadline_s: float, memory_mb: int, max_running: int = 1):
        self.name = name
        self.max_waiting = max_waiting
        self.deadline_s = deadline_s
        self.memory_mb = memory_mb
        self.max_running = max_running
        self._cv = threading.Condition()
        self._waiting = 0
        self._running = 0
        self._executor: ProcessPoolExecutor | None = None

    def _engine(self) -> ProcessPoolExecutor:
        with self._cv:
            if self._executor is None:
                self._executor = ProcessPoolExecutor(
                    max_workers=self.max_running,
                    mp_context=multiprocessing.get_context("forkserver"),
                    initializer=_limit_memory,
                    initargs=(self.memory_mb,),
                )
            return self._executor

    def _discard_engine(self, ex: ProcessPoolExecutor) -> None:
        with self._cv:
            if self._executor is ex:
                self._executor = None
        for p in list(getattr(ex, "_processes", {}).values()):
            p.terminate()
        ex.shutdown(wait=False, cancel_futures=True)

    @property
    def size(self) -> int:
        with self._cv:
            return self._waiting + self._running

    def run(self, fn: Callable[..., Any], *args: Any, cancelled: Callable[[], bool] = client_gone) -> Outcome:
        """Runs the picklable `fn(*args)` in a child process; the result, or why not."""
        if cancelled():
            return Outcome(False, reason="aborted")
        deadline = time.monotonic() + self.deadline_s
        with self._cv:
            if self._waiting >= self.max_waiting:
                return Outcome(False, reason="too-complex")
            self._waiting += 1
            try:
                while self._running >= self.max_running:
                    if cancelled():
                        return Outcome(False, reason="aborted")
                    if time.monotonic() >= deadline:
                        return Outcome(False, reason="too-complex")
                    self._cv.wait(POLL_S)
                if cancelled():
                    return Outcome(False, reason="aborted")
            finally:
                self._waiting -= 1
            self._running += 1
        try:
            ex = self._engine()
            try:
                future = ex.submit(fn, *args)
                value = future.result(timeout=max(0.0, deadline - time.monotonic()))
            except FutureTimeout:
                self._discard_engine(ex)
                return Outcome(False, reason="too-complex")
            except (BrokenProcessPool, MemoryError):
                self._discard_engine(ex)
                return Outcome(False, reason="too-complex")
            if cancelled():
                return Outcome(False, reason="aborted")  # ran to completion; the result is dropped
            return Outcome(True, value=value)
        finally:
            with self._cv:
                self._running -= 1
                self._cv.notify_all()
