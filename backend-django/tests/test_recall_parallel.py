"""Parallel createRecall of one source (D-I3; Task 10 review M3, Task 11 review N3): RECALL_TX repeats the loser once,
and both callers end with the ONE recall — one 201, one 200 — and exactly one OPEN recall row.

Both retry causes are forced deterministically (a fast machine can no longer finish one call before the other reads):

- 40001: the first call is held inside its transaction right after the engine locked the batches and inserted its
  recall, until the second call is seen WAITING for a lock in pg_stat_activity; the first then commits, the second's
  REPEATABLE READ lock fails with 40001 (the batches changed after its snapshot) and its repeat finds the recall;
- 23505 `ux_recalls_open_source`: between the engine's lock (step 3) and its insert (step 4) another session commits
  an OPEN recall of the same source without touching the batches (what a parallel start by another implementation
  could leave); the insert fails on the unique index and the repeat finds that recall.
Each test counts the transaction attempts, so a path that is not taken fails the test."""

from __future__ import annotations

import threading
import time

import pytest
from django.db import connections

from agrotrace.core import sql
from agrotrace.modules.recalls import engine, services
from agrotrace.security.jwt import Principal
from tests.world import World


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def _setup(world: World) -> tuple[Principal, str, dict]:
    farm = world.org("FARM")
    source = world.batch(farm)
    child = world.batch(farm)
    world.link(source, child)
    inspector = world.user(farm, role="INSPECTOR")
    p = Principal(user_id=inspector, org_id=farm, roles=("INSPECTOR",), org_admin=False)
    body = {"sourceBatchId": source, "reason": "Параллельный отзыв", "blockUpstream": False}
    return p, source, body


def _waiting_on_lock(other_session, pid: int) -> bool:
    row = other_session.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", [pid]).fetchone()
    return row is not None and row[0] == "Lock"


def test_the_loser_repeats_after_40001_and_reuses_the_recall(world, monkeypatch, other_session):
    p, source, body = _setup(world)
    real_start = engine.start_recall
    attempts: list[str] = []
    first_in = threading.Event()
    release = threading.Event()
    pids: dict[str, int] = {}
    guard = threading.Lock()

    def start(tx, **kw):
        name = threading.current_thread().name
        with guard:
            attempts.append(name)
            pids[name] = sql.scalar("SELECT pg_backend_pid()")
        out = real_start(tx, **kw)
        if name == "first" and attempts.count("first") == 1:
            first_in.set()
            assert release.wait(timeout=30), "the second call never waited on the batch lock"
        return out

    monkeypatch.setattr(services.engine, "start_recall", start)
    results: dict[str, tuple[int, str]] = {}
    errors: list[BaseException] = []

    def call() -> None:
        try:
            status, view = services.create_recall(p, body)
            results[threading.current_thread().name] = (status, view["id"])
        except BaseException as e:  # noqa: BLE001 - reported below
            errors.append(e)
        finally:
            connections.close_all()

    first = threading.Thread(target=call, name="first")
    first.start()
    assert first_in.wait(timeout=30)
    second = threading.Thread(target=call, name="second")
    second.start()
    deadline = time.monotonic() + 20
    while not ("second" in pids and _waiting_on_lock(other_session, pids["second"])):
        if time.monotonic() > deadline:
            release.set()
            pytest.fail("the second call did not block on the first one's batch lock")
        time.sleep(0.05)
    release.set()
    first.join(timeout=60)
    second.join(timeout=60)
    assert errors == []
    assert attempts.count("first") == 1
    assert attempts.count("second") == 2, "the second call was not repeated (no 40001 retry)"
    assert results["first"][0] == 201 and results["second"][0] == 200
    assert results["first"][1] == results["second"][1]
    assert sql.scalar("SELECT count(*) FROM recalls WHERE source_batch_id = %s", [source]) == 1
    assert sql.scalar("SELECT count(*) FROM recall_batches WHERE recall_id = %s", [results["first"][1]]) == 2


def test_the_loser_repeats_after_23505_on_ux_recalls_open_source(world, monkeypatch, other_session):
    p, source, body = _setup(world)
    real_apply = engine.apply_recall
    calls: list[int] = []
    other: list[str] = []

    def apply(tx, req, members, locked):
        calls.append(1)
        if len(calls) == 1:
            # Committed by another session after this transaction's snapshot and lock, before its insert.
            other.append(other_session.execute(
                "INSERT INTO recalls (source_batch_id, trigger, reason) VALUES (%s, 'INSPECTOR', 'параллельный') "
                "RETURNING id::text", [source]).fetchone()[0])
        return real_apply(tx, req, members, locked)

    monkeypatch.setattr(engine, "apply_recall", apply)
    real_retry = services.RECALL_TX["retry_if"]
    unique_hits: list[bool] = []

    def retry_if(exc):
        hit = real_retry(exc)
        unique_hits.append(hit)
        return hit

    monkeypatch.setitem(services.RECALL_TX, "retry_if", retry_if)
    status, view = services.create_recall(p, body)
    assert unique_hits == [True], "the transaction was not repeated on 23505 ux_recalls_open_source"
    assert len(calls) == 1, "the repeat must find the OPEN recall (step 1) and apply nothing"
    assert status == 200 and view["id"] == other[0]
    assert sql.scalar("SELECT count(*) FROM recalls WHERE source_batch_id = %s", [source]) == 1
