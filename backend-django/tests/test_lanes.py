"""Lanes (P18, D-I7): a slow job misses its 3 s deadline (waiting included) → timeout and the engine is replaced; 1
running + 8 waiting fill a lane and the next job is refused at once; a waiting job of a gone client is removed; the
child comes from the forkserver context under RLIMIT_AS; the engine's start-up is not charged to the job."""

import threading
import time

from agrotrace.infra.lanes import Lane
from tests import lane_jobs


def test_a_slow_job_times_out_at_the_deadline_counting_the_wait():
    lane = Lane("slow", max_waiting=8, deadline_s=1.0, memory_mb=256)
    lane.run(lane_jobs.slow, 0, cancelled=lambda: False)  # warm
    out = {}
    first = threading.Thread(target=lambda: out.setdefault("a", lane.run(lane_jobs.slow, 0.7, cancelled=lambda: False)))
    first.start()
    time.sleep(0.2)
    started = time.monotonic()
    out["b"] = lane.run(lane_jobs.slow, 5, cancelled=lambda: False)  # waits ~0.5 s, then runs into the deadline
    elapsed = time.monotonic() - started
    first.join()
    assert out["a"].ok
    assert (out["b"].reason, out["b"].cause) == ("too-complex", "timeout")
    assert elapsed < 1.6, elapsed
    assert lane.run(lane_jobs.slow, 0, cancelled=lambda: False).ok  # a new engine serves again


def test_one_running_and_eight_waiting_then_busy():
    lane = Lane("busy", max_waiting=8, deadline_s=10, memory_mb=256)
    lane.run(lane_jobs.slow, 0, cancelled=lambda: False)  # warm
    stop = threading.Event()
    threads = [threading.Thread(target=lane.run, args=(lane_jobs.slow, 0.3),
                                kwargs={"cancelled": stop.is_set}) for _ in range(9)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + 5
    while lane.size < 9 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert lane.size == 9
    refused = lane.run(lane_jobs.slow, 0, cancelled=lambda: False)
    assert (refused.reason, refused.cause) == ("too-complex", "busy")
    stop.set()  # the waiting ones are dropped
    for t in threads:
        t.join()
    assert lane.size == 0


def test_a_waiting_job_of_a_gone_client_is_removed():
    lane = Lane("gone", max_waiting=4, deadline_s=10, memory_mb=256)
    gone = threading.Event()
    out = {}
    t1 = threading.Thread(target=lambda: out.setdefault("a", lane.run(lane_jobs.slow, 0.8, cancelled=lambda: False)))
    t1.start()
    time.sleep(0.3)
    t2 = threading.Thread(target=lambda: out.setdefault("b", lane.run(lane_jobs.slow, 0, cancelled=gone.is_set)))
    t2.start()
    time.sleep(0.1)
    gone.set()
    t2.join(2)
    assert out["b"].reason == "aborted"
    t1.join()


def test_children_come_from_forkserver_under_rlimit_as():
    lane = Lane("ctx", max_waiting=1, deadline_s=30, memory_mb=256)
    ex, _ = lane._engine()
    assert ex._mp_context.get_start_method() == "forkserver"
    assert lane.run(lane_jobs.hog, 1024, cancelled=lambda: False).cause == "crashed"  # 1 GiB > 256 MB
    assert lane.run(lane_jobs.hog, 1, cancelled=lambda: False).value == 1024 * 1024


def test_engine_start_up_is_not_charged_to_the_job():
    lane = Lane("cold", max_waiting=1, deadline_s=0.4, memory_mb=256)
    # A cold engine may take longer than 0.4 s to start; the job itself takes 0.2 s.
    assert lane.run(lane_jobs.slow, 0.2, cancelled=lambda: False).ok
