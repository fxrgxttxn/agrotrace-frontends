"""
The beat job `recall-task-overdue` (tag Recalls, BR-08; entity-state-machines.json recallTask OPEN → OVERDUE,
`escalate`, by the system), the port of backend-express/src/scheduler/jobs/recall-task-overdue.ts, every
SCHEDULER_TICK_MS (and once at start) under the session advisory lock `agrotrace.scheduler.recall-task-overdue`
(scheduler.runner). In ONE transaction on the job's connection:

- the OPEN tasks past due — `status = 'OPEN' AND due_at < now()` (the DB clock: now > dueAt, the SQL form of
  `domain.dates.is_overdue`; the stand moves `due_at`, never a clock) — of recalls that are not soft-deleted (their
  tasks are invisible and unconfirmable, tag Recalls; Express review M5 of Tasks 10–11), `ORDER BY due_at, id
  FOR NO KEY UPDATE SKIP LOCKED` (a task a running confirmation holds is seen next tick);
- each becomes OVERDUE (`escalated_at` = the transaction's instant, P43; version + 1) with the audit row
  `system.recallTaskOverdue` (no actor) and a `notification.dispatch` OVERDUE outbox row (requestId null) to the
  task's holder and the inspectors, payload recallId, taskId, batchId, publicCode, dueAt, holderOrgId, holderName.
  An OVERDUE task is never escalated again.

The rows are published by the beat's outbox sweeper (beat has no relay thread); notification.dispatch itself waits
for its handler (Task 12, Ruling Q12).
"""

from __future__ import annotations

from agrotrace.core import audit
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.modules.batches.lifecycle import notify
from agrotrace.scheduler.jobs import Job, register

NAME = "recall-task-overdue"

_DUE = (
    "SELECT t.id::text AS id, t.recall_id::text AS recall_id, t.batch_id::text AS batch_id, "
    "t.holder_org_id::text AS holder_org_id, t.status, t.due_at, t.version FROM recall_tasks t "
    "WHERE t.status = 'OPEN' AND t.due_at < now() "
    "AND NOT EXISTS (SELECT 1 FROM recalls r WHERE r.id = t.recall_id AND r.deleted_at IS NOT NULL) "
    "ORDER BY t.due_at, t.id FOR NO KEY UPDATE OF t SKIP LOCKED"
)


def _tick(tx: Tx) -> int:
    due = tx.all(_DUE)
    if not due:
        return 0
    now = tx.now
    codes = {r["id"]: r["public_code"] for r in tx.all(
        "SELECT id::text AS id, public_code FROM batches WHERE id = ANY(%s::uuid[])",
        [sorted({t["batch_id"] for t in due})])}
    holders = {r["id"]: r["name"] for r in tx.all(
        "SELECT id::text AS id, name FROM organizations WHERE id = ANY(%s::uuid[])",
        [sorted({t["holder_org_id"] for t in due})])}
    for t in due:
        tx.execute("UPDATE recall_tasks SET status = 'OVERDUE', escalated_at = %s, version = %s WHERE id = %s",
                   [now, t["version"] + 1, t["id"]])
        audit.record(tx, action="system.recallTaskOverdue", entity_type="recallTask", entity_id=t["id"], actor=None,
                     diff={"status": [t["status"], "OVERDUE"], "escalatedAt": [None, iso(now)],
                           "version": [t["version"], t["version"] + 1]})
        notify(tx, "OVERDUE", org_ids=[t["holder_org_id"]], roles=["INSPECTOR"], payload={
            "recallId": t["recall_id"], "taskId": t["id"], "batchId": t["batch_id"],
            "publicCode": codes[t["batch_id"]], "dueAt": iso(t["due_at"]), "holderOrgId": t["holder_org_id"],
            "holderName": holders[t["holder_org_id"]]}, request_id=None)
    return len(due)


def run() -> int:
    """One tick; the number of tasks escalated."""
    return with_tx(_tick)


JOB = register(Job(NAME, run))
