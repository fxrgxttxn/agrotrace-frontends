"""The recall engine's raw recursive SQL on agrotrace_test_django, over a graph of its own (contract tag Recalls,
steps 2–7; п. 7.6, R59): DOWN — every descendant at its smallest depth; UP only with `blockUpstream`, without the
ancestors' other descendants; a batch found DOWN is not repeated UP; soft-deleted batches are walked THROUGH but are
not members — their status is left as is and they get no task; the walk stops at depth 20."""

from __future__ import annotations

import pytest

from agrotrace.core import sql
from agrotrace.core.tx import RECALL_TX, with_tx
from agrotrace.modules.recalls import engine
from tests.world import World


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def scope(source: str, up: bool) -> list[tuple[str, str, int]]:
    members = with_tx(lambda tx: engine.recall_scope(tx, source, up), isolation="repeatable read")
    return sorted((m.batch_id, m.direction, m.depth) for m in members)


def test_down_and_up_at_the_smallest_depth(world):
    farm = world.org("FARM")
    a, x = world.batch(farm, status="Processed"), world.batch(farm, status="Processed")
    b, c, d, e = (world.batch(farm, status=s, kind="DERIVED") for s in ("Processed", "Approved", "Processed",
                                                                       "Approved"))
    # a → b → d → e, a → c, x → d, and a short cut a → d (d is at depth 1 from a, not 2).
    for p, ch in ((a, b), (b, d), (d, e), (a, c), (x, d), (a, d)):
        world.link(p, ch)
    assert scope(a, False) == sorted([(a, "SOURCE", 0), (b, "DOWN", 1), (c, "DOWN", 1), (d, "DOWN", 1),
                                      (e, "DOWN", 2)])
    # Without blockUpstream nothing above the source.
    assert scope(d, False) == sorted([(d, "SOURCE", 0), (e, "DOWN", 1)])
    # UP: the ancestors (a at its smallest depth 1 through the short cut), never their other descendants (c).
    assert scope(d, True) == sorted([(d, "SOURCE", 0), (e, "DOWN", 1), (b, "UP", 1), (x, "UP", 1), (a, "UP", 1)])


def test_a_batch_found_down_is_not_repeated_up(world):
    farm = world.org("FARM")
    s, t = world.batch(farm), world.batch(farm, kind="DERIVED")
    world.link(s, t)
    world.link(t, s)  # a cycle (data state): t is a descendant and an ancestor
    assert scope(s, True) == sorted([(s, "SOURCE", 0), (t, "DOWN", 1)])


def test_the_walk_passes_through_soft_deleted_batches_without_touching_them(world):
    farm = world.org("FARM")
    proc = world.org("PROCESSOR")
    a = world.batch(farm, status="Processed")
    gone = world.batch(farm, status="Approved", holder=proc, kind="DERIVED", deleted=True)
    c = world.batch(farm, status="Approved", holder=proc, kind="DERIVED")
    world.link(a, gone)
    world.link(gone, c)
    assert scope(a, False) == sorted([(a, "SOURCE", 0), (c, "DOWN", 2)])
    assert scope(c, True) == sorted([(c, "SOURCE", 0), (a, "UP", 2)])

    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=a, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Тест обхода"), **RECALL_TX)
    assert out.created and not out.closed and len(out.task_ids) == 1
    members = sql.all("SELECT batch_id::text AS id, direction, depth, status_before FROM recall_batches "
                      "WHERE recall_id = %s ORDER BY depth", [out.recall_id])
    assert [(m["id"], m["direction"], m["depth"], m["status_before"]) for m in members] == [
        (a, "SOURCE", 0, "Processed"), (c, "DOWN", 2, "Approved")]
    # The deleted batch: same status, same version, no history, no task.
    assert sql.one("SELECT status, version FROM batches WHERE id = %s", [gone]) == {"status": "Approved", "version": 1}
    assert sql.scalar("SELECT count(*) FROM batch_status_history WHERE batch_id = %s", [gone]) == 0
    tasks = sql.all("SELECT batch_id::text AS b, holder_org_id::text AS h FROM recall_tasks WHERE recall_id = %s",
                    [out.recall_id])
    assert tasks == [{"b": c, "h": proc}]
    assert sql.scalar("SELECT status FROM batches WHERE id = %s", [c]) == "Recalled"
    # Processed keeps its status and gets no task (п. 5.1).
    assert sql.scalar("SELECT status FROM batches WHERE id = %s", [a]) == "Processed"
    # P43: the task's createdAt is the recall's openedAt; dueAt = openedAt + 24 h (BR-08).
    r = sql.one("SELECT opened_at, created_at FROM recalls WHERE id = %s", [out.recall_id])
    t = sql.one("SELECT created_at, due_at FROM recall_tasks WHERE recall_id = %s", [out.recall_id])
    assert r["opened_at"] == r["created_at"] == t["created_at"]
    assert (t["due_at"] - r["opened_at"]).total_seconds() == 86_400


def test_the_depth_is_bounded_by_20(world):
    farm = world.org("FARM")
    chain = [world.batch(farm, status="Processed")]
    for _ in range(22):
        nxt = world.batch(farm, status="Processed", kind="DERIVED")
        world.link(chain[-1], nxt)
        chain.append(nxt)
    got = scope(chain[0], False)
    assert [d for _id, _dir, d in sorted(got, key=lambda m: m[2])] == list(range(21))
    assert {i for i, _d, _n in got} == set(chain[:21])
    up = scope(chain[-1], True)
    assert max(d for *_x, d in up) == 20 and len(up) == 21


def test_a_recall_without_tasks_closes_at_once(world):
    farm = world.org("FARM")
    sold = world.batch(farm, status="Sold")
    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=sold, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Пусто"), **RECALL_TX)
    assert out.created and out.closed and out.task_ids == []
    r = sql.one("SELECT status, version, opened_at, closed_at FROM recalls WHERE id = %s", [out.recall_id])
    assert r["status"] == "CLOSED" and r["version"] == 2 and r["closed_at"] == r["opened_at"]
    # Reuse: the source has no OPEN recall, so a second start creates another one (closed too).
    again = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=sold, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Пусто"), **RECALL_TX)
    assert again.created and again.recall_id != out.recall_id
