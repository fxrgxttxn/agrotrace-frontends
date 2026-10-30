"""
Heavy work off the request threads (P18 SVG, P24 XLSX, reports — used from Task 3), the port of
backend-express/src/infra/worker-queue.ts: a child-process engine behind a bounded queue.

- child processes come from `multiprocessing.get_context('forkserver')` (the uvicorn process is multi-threaded, so
  `fork` is unsafe) and run under `RLIMIT_AS = memory_mb` (exceeding it kills the job, never the API, D-M3);
- at most `max_waiting` jobs wait and `max_running` run; an overflow is refused at once (`too-complex`, cause `busy`);
- every job has one deadline counted from enqueue, waiting included; the only time it does not count is the start-up
  of the engine the job itself runs on (its clock pauses while a new child starts — a respawn is charged to nobody);
- a missed deadline (cause `timeout`) or a crash of the engine (cause `crashed`) terminates the engine's process — the
  work stops — and the next engine starts after a back-off (100 ms doubling to 2 s, reset after a completed job);
  with `max_running > 1` the jobs running beside it on that engine are lost too through no fault of their own: they
  get cause `evicted` (callers treat it as an overload, never as a bad input);
- a client that goes away (`cancelled()`, by default `core.context.client_gone`, D-I7): a WAITING job is removed and
  never executed (`aborted`); a running one runs to completion and its result is dropped.
"""

from __future__ import annotations

import multiprocessing
import threading
import time
from collections.abc import Callable
from concurrent.futures import CancelledError, ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from typing import Any, Literal

from agrotrace.core.context import client_gone

POLL_S = 0.02
BACKOFF_MIN_S = 0.1
BACKOFF_MAX_S = 2.0
STARTUP_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class Outcome:
    ok: bool
    value: Any = None
    reason: Literal["too-complex", "aborted"] | None = None
    #: Why `too-complex`: the lane was full (`busy`), the deadline passed (`timeout`), this job's engine died under it
    #: (`crashed`), or the engine was discarded because of ANOTHER job running beside this one (`evicted`).
    cause: Literal["busy", "timeout", "crashed", "evicted"] | None = None


def _limit_memory(memory_mb: int) -> None:  # pragma: no cover - runs in the child
    import resource

    limit = memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def _ready() -> bool:  # pragma: no cover - runs in the child
    return True


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
        self._backoff = BACKOFF_MIN_S
        self._respawn_at = 0.0

    def _engine(self) -> tuple[ProcessPoolExecutor, float]:
        """The current engine and the seconds its start-up took (0 for a warm one). A new engine waits out the
        back-off, then starts its child(ren) before the job is submitted."""
        with self._cv:
            ex = self._executor
            if ex is not None:
                return ex, 0.0
            wait = self._respawn_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        started = time.monotonic()
        ex = ProcessPoolExecutor(
            max_workers=self.max_running,
            mp_context=multiprocessing.get_context("forkserver"),
            initializer=_limit_memory,
            initargs=(self.memory_mb,),
        )
        try:
            for f in [ex.submit(_ready) for _ in range(self.max_running)]:
                f.result(timeout=STARTUP_TIMEOUT_S)
        except Exception:
            self._kill(ex)
            raise
        with self._cv:
            if self._executor is None:
                self._executor = ex
            else:  # another job started one meanwhile
                self._kill(ex)
                return self._executor, time.monotonic() - started
        return ex, time.monotonic() - started

    @staticmethod
    def _kill(ex: ProcessPoolExecutor) -> None:
        """Terminates the engine's children. Tolerant of an engine that is already broken or shut down (its
        `_processes` is then None) and of a child that is already gone — it may be discarded twice (review N6)."""
        for p in list((getattr(ex, "_processes", None) or {}).values()):
            try:
                p.terminate()
            except Exception:  # noqa: S110 - already exited
                pass
        try:
            ex.shutdown(wait=False, cancel_futures=True)
        except Exception:  # noqa: S110 - a broken executor may refuse a second shutdown
            pass

    def _discard_engine(self, ex: ProcessPoolExecutor) -> None:
        with self._cv:
            ex._agrotrace_discarded = True  # type: ignore[attr-defined]  # neighbours: `evicted`, not `crashed`
            if self._executor is ex:
                self._executor = None
                self._respawn_at = time.monotonic() + self._backoff
                self._backoff = min(self._backoff * 2, BACKOFF_MAX_S)
        self._kill(ex)

    @staticmethod
    def _discarded(ex: ProcessPoolExecutor) -> bool:
        return getattr(ex, "_agrotrace_discarded", False)

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
                return Outcome(False, reason="too-complex", cause="busy")
            self._waiting += 1
            try:
                while self._running >= self.max_running:
                    if cancelled():
                        return Outcome(False, reason="aborted")
                    if time.monotonic() >= deadline:
                        return Outcome(False, reason="too-complex", cause="timeout")
                    self._cv.wait(POLL_S)
                if cancelled():
                    return Outcome(False, reason="aborted")
            finally:
                self._waiting -= 1
            self._running += 1
        try:
            try:
                ex, startup = self._engine()
            except Exception:
                return Outcome(False, reason="too-complex", cause="crashed")
            deadline += startup
            try:
                future = ex.submit(fn, *args)
                value = future.result(timeout=max(0.0, deadline - time.monotonic()))
            except FutureTimeout:
                self._discard_engine(ex)
                return Outcome(False, reason="too-complex", cause="timeout")
            except (BrokenProcessPool, CancelledError, RuntimeError, MemoryError):
                # RuntimeError: submit() on an engine shut down meanwhile; CancelledError: queued on it when it was
                # shut down. If another job already discarded this engine, this job is its innocent neighbour.
                if self._discarded(ex):
                    return Outcome(False, reason="too-complex", cause="evicted")
                self._discard_engine(ex)
                return Outcome(False, reason="too-complex", cause="crashed")
            with self._cv:
                self._backoff = BACKOFF_MIN_S
            if cancelled():
                return Outcome(False, reason="aborted")  # ran to completion; the result is dropped
            return Outcome(True, value=value)
        finally:
            with self._cv:
                self._running -= 1
                self._cv.notify_all()
