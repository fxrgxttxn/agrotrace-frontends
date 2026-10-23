"""Two parallel createRecall of one source (D-I3, Task 10 review M3): RECALL_TX repeats the loser once (23505
`ux_recalls_open_source` or 40001 on the batch lock), so both succeed with the ONE recall — one 201, one 200 — and
exactly one recall row exists."""

from __future__ import annotations

import threading

import pytest
from django.db import connections

from agrotrace.core import sql
from agrotrace.modules.recalls import services
from agrotrace.security.jwt import Principal
from tests.world import World


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def test_two_parallel_create_recall_end_with_one_recall(world):
    farm = world.org("FARM")
    source = world.batch(farm)
    child = world.batch(farm)
    world.link(source, child)
    inspector = world.user(farm, role="INSPECTOR")
    p = Principal(user_id=inspector, org_id=farm, roles=("INSPECTOR",), org_admin=False)
    body = {"sourceBatchId": source, "reason": "Параллельный отзыв", "blockUpstream": False}
    barrier = threading.Barrier(2)
    results: list[tuple[int, str]] = []
    errors: list[BaseException] = []

    def call() -> None:
        try:
            barrier.wait(timeout=10)
            status, view = services.create_recall(p, body)
            results.append((status, view["id"]))
        except BaseException as e:  # noqa: BLE001 - reported below
            errors.append(e)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert errors == []
    assert sorted(s for s, _ in results) == [200, 201]
    assert len({rid for _, rid in results}) == 1
    assert sql.scalar("SELECT count(*) FROM recalls WHERE source_batch_id = %s", [source]) == 1
    assert sql.scalar("SELECT count(*) FROM recall_batches WHERE recall_id = %s", [results[0][1]]) == 2
