"""
The api process under ASGI (plan 3 «Процесс api: ASGI», D-I7): synchronous views run in parallel threads; a client
that disconnects leaves no pool connection checked out (each view call ends with connections.close_all() in its own
thread); `client_gone()` turns True in the view's thread; a waiting Lane job of a gone client is removed unexecuted.
"""

import asyncio
import threading
import time
from pathlib import Path

import pytest
from django.db import connection
from django.test import override_settings

from agrotrace.infra.lanes import Lane
from tests import asgi_urls, lane_jobs
from tests.asgi_client import call


@override_settings(ROOT_URLCONF="tests.asgi_urls")
def test_two_sync_requests_run_in_parallel():
    async def both():
        t0 = time.perf_counter()
        a, b = await asyncio.gather(call("GET", "/api/v1/test/sleep"), call("GET", "/api/v1/test/sleep"))
        return time.perf_counter() - t0, a, b

    elapsed, a, b = asyncio.run(both())
    assert a.status == b.status == 200
    assert a.headers["x-backend"] == "django" and a.headers["x-request-id"] != b.headers["x-request-id"]
    assert elapsed < 0.9, elapsed


def _checked_out() -> int:
    stats = connection.pool.get_stats()
    return stats["pool_size"] - stats["pool_available"]


@override_settings(ROOT_URLCONF="tests.asgi_urls")
def test_requests_abandoned_during_a_query_return_their_connections(db):
    asgi_urls.RECORD["db_done"] = 0

    async def twenty():
        return await asyncio.gather(*(call("GET", "/api/v1/test/db-sleep", disconnect_after=0.1)
                                      for _ in range(20)))

    results = asyncio.run(twenty())
    assert all(r.status is None for r in results)  # nobody got a response: every client went away
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and (asgi_urls.RECORD["db_done"] < 20 or _checked_out() > 0):
        time.sleep(0.05)
    assert asgi_urls.RECORD["db_done"] == 20
    assert _checked_out() == 0
    assert connection.pool.get_stats().get("requests_waiting", 0) == 0


@override_settings(ROOT_URLCONF="tests.asgi_urls")
def test_client_gone_turns_true_in_the_view_thread():
    async def both():
        await asyncio.gather(
            call("GET", "/api/v1/test/gone", headers={"x-probe": "left"}, disconnect_after=0.1),
            call("GET", "/api/v1/test/gone", headers={"x-probe": "stayed"}),
        )

    asyncio.run(both())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and "left" not in asgi_urls.RECORD:
        time.sleep(0.05)
    assert asgi_urls.RECORD["left"] is True
    assert asgi_urls.RECORD["stayed"] is False


def test_a_waiting_lane_job_of_a_gone_client_is_removed_and_never_runs(tmp_path: Path):
    lane = Lane("test", max_waiting=4, deadline_s=10, memory_mb=512)
    marker = tmp_path / "ran"
    gone = threading.Event()
    out = {}

    def first():
        out["first"] = lane.run(lane_jobs.slow, 1.0, cancelled=lambda: False)

    def second():
        out["second"] = lane.run(lane_jobs.touch, str(marker), cancelled=gone.is_set)

    t1 = threading.Thread(target=first)
    t1.start()
    deadline = time.monotonic() + 30  # the first job may wait for the forkserver to start
    while lane._running == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    t2 = threading.Thread(target=second)
    t2.start()
    time.sleep(0.2)
    assert lane.size == 2
    gone.set()
    t2.join(5)
    assert out["second"].ok is False and out["second"].reason == "aborted"
    t1.join(30)
    assert out["first"].ok is True and out["first"].value == "slow done"
    time.sleep(0.2)
    assert not marker.exists()
    assert lane.size == 0


def test_lane_bounds_and_memory_limit():
    lane = Lane("bounded", max_waiting=0, deadline_s=10, memory_mb=256)
    assert lane.run(lane_jobs.slow, 0, cancelled=lambda: False).reason == "too-complex"  # no waiting slot at all
    lane = Lane("memory", max_waiting=1, deadline_s=30, memory_mb=256)
    assert lane.run(lane_jobs.hog, 1024, cancelled=lambda: False).reason == "too-complex"  # RLIMIT_AS in the child
    assert lane.run(lane_jobs.hog, 1, cancelled=lambda: False).value == 1024 * 1024  # the engine was replaced
    lane = Lane("deadline", max_waiting=1, deadline_s=0.5, memory_mb=256)
    lane.run(lane_jobs.hog, 1, cancelled=lambda: False)  # warm the engine
    t0 = time.perf_counter()
    assert lane.run(lane_jobs.slow, 5, cancelled=lambda: False).reason == "too-complex"
    assert time.perf_counter() - t0 < 2


@pytest.mark.parametrize("raw", [b"//api/v1/health/live", b"/api/v1/health//live", b"/api/v1/docs/%zz",
                                 b"/api/v1/docs/%E0%A4%A", b"/api/v1/health/%ff"])
def test_raw_path_refusals(raw):
    r = asyncio.run(call("GET", raw.decode("latin-1"), raw_path=raw))
    assert r.status == 404 and r.headers["content-type"] == "application/problem+json"
    assert r.headers["x-backend"] == "django"
