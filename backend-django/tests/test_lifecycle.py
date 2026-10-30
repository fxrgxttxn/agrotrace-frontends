"""PORT and SHUTDOWN_TIMEOUT_MS are used as Express uses them (final review M4): the api listens on PORT and gives
in-flight requests SHUTDOWN_TIMEOUT_MS; worker and beat end with exit code 1 when a stop outlasts it by 2 s."""

from __future__ import annotations

import dataclasses
import threading

from agrotrace import serve
from agrotrace.celery_app import _shutdown_watchdog
from agrotrace.core import config, lifecycle
from agrotrace.scheduler import beat


def test_the_api_listens_on_port_and_waits_shutdown_timeout_for_requests():
    cfg = dataclasses.replace(config.get(), PORT=8123, SHUTDOWN_TIMEOUT_MS=7500)
    opts = serve.uvicorn_options(cfg)
    assert opts["port"] == 8123 and opts["timeout_graceful_shutdown"] == 7.5
    assert opts["workers"] == 1 and opts["access_log"] is False and opts["server_header"] is False


def test_the_watchdog_exits_1_after_the_timeout_plus_2_s(monkeypatch):
    monkeypatch.setattr(lifecycle, "GRACE_MS", 50)
    exited = threading.Event()
    codes: list[int] = []
    t = lifecycle.exit_after(0, _exit=lambda code: (codes.append(code), exited.set()))
    assert t.daemon and t.interval == 0.05
    assert exited.wait(5) and codes == [1]


def test_a_cancelled_watchdog_never_exits():
    codes: list[int] = []
    t = lifecycle.exit_after(10, _exit=codes.append)
    assert t.interval == 2.01
    t.cancel()
    t.join(5)
    assert codes == []


def test_the_worker_arms_the_watchdog_on_warm_shutdown(monkeypatch):
    armed: list[int] = []
    monkeypatch.setattr(lifecycle, "exit_after", lambda ms: armed.append(ms))
    monkeypatch.setattr(config, "get", lambda: dataclasses.replace(config.load(), SHUTDOWN_TIMEOUT_MS=4321))
    _shutdown_watchdog(sig="SIGTERM", how="Warm", exitcode=0)
    assert armed == [4321]


def test_beat_close_arms_the_watchdog_and_cancels_it_once_closed(monkeypatch):
    class Timer:
        cancelled = False

        def cancel(self):
            Timer.cancelled = True

    armed: list[int] = []
    monkeypatch.setattr(lifecycle, "exit_after", lambda ms: (armed.append(ms), Timer())[1])
    sched = beat.InProcessScheduler.__new__(beat.InProcessScheduler)
    sched._pool = type("Pool", (), {"shutdown": lambda self, **kw: armed.append(kw)})()
    monkeypatch.setattr(beat.Scheduler, "close", lambda self: None)
    sched.close()
    assert armed == [config.get().SHUTDOWN_TIMEOUT_MS, {"wait": True, "cancel_futures": True}]
    assert Timer.cancelled


def test_the_api_arms_the_watchdog_on_the_first_sigterm_then_runs_the_previous_handler(monkeypatch):
    """Re-review m1: as Express's api, the signal itself arms the exit(1) at SHUTDOWN_TIMEOUT_MS + 2 s."""
    import signal

    from agrotrace import asgi

    installed = {}
    calls: list[str] = []
    armed: list[int] = []
    monkeypatch.setattr(signal, "getsignal", lambda sig: lambda s, f: calls.append("uvicorn"))
    monkeypatch.setattr(signal, "signal", lambda sig, fn: installed.setdefault(sig, fn))
    monkeypatch.setattr(lifecycle, "exit_after", lambda ms: armed.append(ms))
    assert asgi.STARTUP[-1] is asgi._arm_shutdown_watchdog
    lifecycle.exit_after_on_sigterm(4321)
    installed[signal.SIGTERM](signal.SIGTERM, None)
    installed[signal.SIGTERM](signal.SIGTERM, None)
    assert armed == [4321] and calls == ["uvicorn", "uvicorn"]
