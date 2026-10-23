"""The `recall.requested` and `rating.recalculate` handlers on agrotrace_test_django (R55/R56, R89): one transaction
starting with the claim — RECALL OPENED (inspectors, every task holder, the source's origin) only while the recall is
OPEN, not deleted and has tasks; RECALL_TASK CREATED per task to its holder; `rating.recalculate` (RECALL_SOURCE, the
handled event's requestId) for a FARM origin. A redelivery finds its claim and writes nothing."""

from __future__ import annotations

import uuid

import pytest

from agrotrace.core import sql
from agrotrace.core.render import iso
from agrotrace.core.tx import RECALL_TX, with_tx
from agrotrace.events.handlers import HANDLED_TYPES, rating_recalculate, recall_requested
from agrotrace.modules.recalls import engine
from tests.world import World


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def _envelope(recall_id: str, source: str, *, request_id: str | None = "req-1") -> dict:
    return {"id": str(uuid.uuid4()), "type": "recall.requested", "occurredAt": "2026-10-23T10:00:00.000Z",
            "backend": "django", "requestId": request_id,
            "data": {"recallId": recall_id, "sourceBatchId": source, "trigger": "INSPECTOR", "openedBy": None}}


def _notes(user_ids: list[str]) -> list[tuple[str, str, str, str]]:
    rows = sql.all("SELECT user_id::text AS u, type, channel, payload FROM notifications "
                   "WHERE user_id = ANY(%s::uuid[])", [user_ids])
    return sorted((r["u"], r["type"], r["channel"], sql.jsonb(r["payload"]).get("event")) for r in rows)


def test_both_types_are_published_now():
    assert {"recall.requested", "rating.recalculate"} <= set(HANDLED_TYPES)
    assert "notification.dispatch" not in HANDLED_TYPES  # Task 12


def test_recall_requested_fans_out_once(world):
    farm, proc = world.org("FARM"), world.org("PROCESSOR")
    authority = world.org("AUTHORITY")
    farmer, worker, inspector = world.user(farm), world.user(proc), world.user(authority, role="INSPECTOR")
    src = world.batch(farm, status="Processed")
    child = world.batch(farm, status="Approved", holder=proc, kind="DERIVED")
    world.link(src, child)
    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=src, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Тест"), **RECALL_TX)
    env = _envelope(out.recall_id, src)
    recall_requested.handle(env)
    users = [farmer, worker, inspector]
    # RECALL and RECALL_TASK are forced types: EMAIL besides IN_APP for everybody (Telegram is not linked).
    assert _notes(users) == sorted([
        *((u, "RECALL", ch, "OPENED") for u in users for ch in ("IN_APP", "EMAIL")),
        *((worker, "RECALL_TASK", ch, "CREATED") for ch in ("IN_APP", "EMAIL"))])
    task = sql.one("SELECT id::text AS id, due_at FROM recall_tasks WHERE recall_id = %s", [out.recall_id])
    payload = sql.jsonb(sql.scalar("SELECT payload FROM notifications WHERE user_id = %s AND type = 'RECALL_TASK' "
                                   "AND channel = 'IN_APP'", [worker]))
    code = sql.scalar("SELECT public_code FROM batches WHERE id = %s", [child])
    assert payload == {"recallId": out.recall_id, "taskId": task["id"], "batchId": child, "publicCode": code,
                       "dueAt": iso(task["due_at"]), "event": "CREATED"}
    [ev] = [sql.jsonb(r["payload"]) for r in sql.all(
        "SELECT payload FROM outbox_events WHERE type = 'rating.recalculate' AND payload->'data'->>'sourceId' = %s",
        [out.recall_id])]
    assert ev["requestId"] == "req-1"
    assert ev["data"] == {"organizationId": farm, "cause": "RECALL_SOURCE", "sourceId": out.recall_id}

    before = _notes(users)
    recall_requested.handle(env)  # redelivered
    assert _notes(users) == before
    assert sql.scalar("SELECT count(*) FROM outbox_events WHERE type = 'rating.recalculate' "
                      "AND payload->'data'->>'sourceId' = %s", [out.recall_id]) == 1

    # rating.recalculate: claim, then the full fold (80 − 10).
    rating_env = ev
    rating_recalculate.handle(rating_env)
    assert sql.scalar("SELECT trust_rating FROM organizations WHERE id = %s", [farm]) == 70
    sql.execute("UPDATE organizations SET trust_rating = 80 WHERE id = %s", [farm])
    rating_recalculate.handle(rating_env)  # claimed: nothing
    assert sql.scalar("SELECT trust_rating FROM organizations WHERE id = %s", [farm]) == 80


def test_no_opened_for_a_recall_closed_at_creation(world):
    proc = world.org("PROCESSOR")
    authority = world.org("AUTHORITY")
    inspector, worker = world.user(authority, role="INSPECTOR"), world.user(proc)
    src = world.batch(proc, status="Sold")  # not a farm: no rating event either
    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=src, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Тест"), **RECALL_TX)
    assert out.closed
    recall_requested.handle(_envelope(out.recall_id, src))
    assert _notes([inspector, worker]) == []
    assert sql.scalar("SELECT count(*) FROM outbox_events WHERE type = 'rating.recalculate' "
                      "AND payload->'data'->>'sourceId' = %s", [out.recall_id]) == 0
