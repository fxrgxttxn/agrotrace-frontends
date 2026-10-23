"""The beat jobs `lab-escalation` (Task 9 review M5) and `recall-task-overdue` (BR-08) on agrotrace_test_django: past
due by the DB clock → escalated once (status, escalated_at = the transaction's instant, version + 1, a system audit
row, one outbox row with requestId null); a row a request holds is skipped (SKIP LOCKED) and taken by a later tick;
rows nobody may see are never escalated (a test of a soft-deleted batch, a deleted test, a task of a soft-deleted
recall)."""

from __future__ import annotations

import pytest

from agrotrace.core import sql
from agrotrace.core.render import iso
from agrotrace.core.tx import RECALL_TX, with_tx
from agrotrace.modules.recalls import engine
from agrotrace.scheduler.jobs import lab_escalation, recall_task_overdue
from tests.world import World


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def outbox(type_: str, key: str, value: str) -> list[dict]:
    return [sql.jsonb(r["payload"]) for r in sql.all(
        "SELECT payload FROM outbox_events WHERE backend = 'django' AND type = %s AND payload->'data'->>%s = %s",
        [type_, key, value])]


def overdue_events(task_id: str) -> list[dict]:
    return [e for e in outbox("notification.dispatch", "notificationType", "OVERDUE")
            if e["data"]["payload"]["taskId"] == task_id]


def past(test_or_task: str, table: str) -> None:
    sql.execute(f"UPDATE {table} SET due_at = now() - interval '1 second' WHERE id = %s", [test_or_task])


def test_lab_escalation(world, other_session):
    farm, lab = world.org("FARM"), world.org("LAB")
    b, gone = world.batch(farm, status="OnTest"), world.batch(farm, status="OnTest", deleted=True)
    late = world.lab_test(b, lab)
    sampled = world.lab_test(b, lab, status="SAMPLED")
    on_time = world.lab_test(b, lab)
    of_deleted_batch = world.lab_test(gone, lab)
    deleted = world.lab_test(b, lab, deleted=True)
    held = world.lab_test(b, lab)
    for t in (late, sampled, of_deleted_batch, deleted, held):
        past(t, "lab_tests")

    with other_session.transaction():
        other_session.execute("SELECT 1 FROM lab_tests WHERE id = %s FOR NO KEY UPDATE", [held])
        lab_escalation.run()
    rows = {r["id"]: r for r in sql.all(
        "SELECT id::text AS id, status, version, escalated_at FROM lab_tests WHERE id = ANY(%s::uuid[])",
        [[late, sampled, on_time, of_deleted_batch, deleted, held]])}
    assert {k: (v["status"], v["version"]) for k, v in rows.items()} == {
        late: ("ESCALATED", 2), sampled: ("ESCALATED", 2), on_time: ("QUEUED", 1), of_deleted_batch: ("QUEUED", 1),
        deleted: ("QUEUED", 1), held: ("QUEUED", 1)}
    # One transaction, one instant.
    assert rows[late]["escalated_at"] == rows[sampled]["escalated_at"]
    [ev] = outbox("lab.escalate", "labTestId", late)
    assert ev["requestId"] is None
    assert ev["data"]["escalatedAt"] == iso(rows[late]["escalated_at"])
    audit = sql.all("SELECT actor_id, diff FROM audit_log WHERE entity_id = %s AND action = 'system.labTestEscalate'",
                    [late])
    assert len(audit) == 1 and audit[0]["actor_id"] is None
    assert sql.jsonb(audit[0]["diff"])["status"] == ["QUEUED", "ESCALATED"]

    # Next tick: the released test is taken; the escalated ones are not touched again.
    lab_escalation.run()
    assert sql.scalar("SELECT status FROM lab_tests WHERE id = %s", [held]) == "ESCALATED"
    assert sql.scalar("SELECT version FROM lab_tests WHERE id = %s", [late]) == 2
    assert len(outbox("lab.escalate", "labTestId", late)) == 1


def _recall(world: World, *holders: str) -> list[str]:
    farm = world.org("FARM")
    src = world.batch(farm, status="Processed")
    for h in holders:
        world.link(src, world.batch(farm, status="Approved", holder=h, kind="DERIVED"))
    out = with_tx(lambda tx: engine.start_recall(
        tx, source_batch_id=src, trigger="INSPECTOR", opened_by=None, block_upstream=False, action="createRecall",
        reason="Тест просрочки"), **RECALL_TX)
    return [r["id"] for r in sql.all("SELECT t.id::text AS id FROM recall_tasks t JOIN batches b ON b.id = t.batch_id "
                                     "WHERE t.recall_id = %s ORDER BY b.holder_org_id", [out.recall_id])]


def test_recall_task_overdue(world, other_session):
    retailer = world.org("RETAILER", "Магазин «Тест»")
    late, on_time, held = (_recall(world, retailer)[0] for _ in range(3))
    deleted_task = _recall(world, retailer)[0]
    sql.execute("UPDATE recalls SET deleted_at = now() WHERE id = (SELECT recall_id FROM recall_tasks WHERE id = %s)",
                [deleted_task])
    for t in (late, held, deleted_task):
        past(t, "recall_tasks")

    with other_session.transaction():
        other_session.execute("SELECT 1 FROM recall_tasks WHERE id = %s FOR NO KEY UPDATE", [held])
        recall_task_overdue.run()
    rows = {r["id"]: r for r in sql.all(
        "SELECT id::text AS id, status, version, escalated_at, due_at, batch_id::text AS batch_id, "
        "recall_id::text AS recall_id FROM recall_tasks WHERE id = ANY(%s::uuid[])",
        [[late, on_time, held, deleted_task]])}
    assert {k: (v["status"], v["version"]) for k, v in rows.items()} == {
        late: ("OVERDUE", 2), on_time: ("OPEN", 1), held: ("OPEN", 1), deleted_task: ("OPEN", 1)}
    r = rows[late]
    code = sql.scalar("SELECT public_code FROM batches WHERE id = %s", [r["batch_id"]])
    [ev] = overdue_events(late)
    assert ev["requestId"] is None
    assert ev["data"] == {
        "notificationType": "OVERDUE",
        "recipients": {"userIds": [], "orgIds": [retailer], "orgHeadIds": [], "roles": ["INSPECTOR"]},
        "payload": {"recallId": r["recall_id"], "taskId": late, "batchId": r["batch_id"], "publicCode": code,
                    "dueAt": iso(r["due_at"]), "holderOrgId": retailer, "holderName": "Магазин «Тест»"}}
    audit = sql.all("SELECT actor_id, diff FROM audit_log WHERE entity_id = %s AND action = 'system.recallTaskOverdue'",
                    [late])
    assert [(a["actor_id"], sql.jsonb(a["diff"])) for a in audit] == [
        (None, {"status": ["OPEN", "OVERDUE"], "escalatedAt": [None, iso(r["escalated_at"])], "version": [1, 2]})]

    # Next tick: the released task is escalated; an OVERDUE task never again.
    recall_task_overdue.run()
    assert sql.scalar("SELECT status FROM recall_tasks WHERE id = %s", [held]) == "OVERDUE"
    assert sql.scalar("SELECT version FROM recall_tasks WHERE id = %s", [late]) == 2
    assert sql.scalar("SELECT status FROM recall_tasks WHERE id = %s", [deleted_task]) == "OPEN"
    assert len(overdue_events(late)) == 1
