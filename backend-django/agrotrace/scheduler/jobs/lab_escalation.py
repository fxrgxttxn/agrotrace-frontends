"""
The beat job `lab-escalation` (tag Lab, БП-2; contracts/events/lab.escalate.schema.json), the port of
backend-express/src/scheduler/jobs/lab-escalation.ts, every SCHEDULER_TICK_MS (and once at start) under the session
advisory lock `agrotrace.scheduler.lab-escalation` (scheduler.runner). In ONE transaction on the job's connection:

- the open tests past due — `status IN ('QUEUED','SAMPLED') AND due_at < now() AND deleted_at IS NULL`, whose batch is
  not soft-deleted (tests of a deleted batch are invisible to everybody), `ORDER BY due_at, id FOR NO KEY UPDATE SKIP
  LOCKED` (a test a request holds is left for the next tick). `now() > due` is only ever the database clock: the test
  stand moves `due_at` (P48), never a clock;
- each becomes ESCALATED (`escalated_at` = the transaction's instant, P43; version + 1) with an audit row
  `system.labTestEscalate` (no actor) and a `lab.escalate` outbox row (requestId null). Its handler (worker,
  events/handlers/lab_escalate.py) writes LAB_OVERDUE for the laboratory's heads and the inspectors.

The rows are published by the beat's outbox sweeper (beat has no relay thread).
"""

from __future__ import annotations

from agrotrace.core import audit
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import outbox
from agrotrace.scheduler.jobs import Job, register

NAME = "lab-escalation"

_DUE = (
    "SELECT t.id::text AS id, t.lab_org_id::text AS lab_org_id, t.batch_id::text AS batch_id, t.status, t.due_at, "
    "t.version FROM lab_tests t "
    "WHERE t.status IN ('QUEUED', 'SAMPLED') AND t.due_at < now() AND t.deleted_at IS NULL "
    "AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = t.batch_id AND b.deleted_at IS NOT NULL) "
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
    for t in due:
        tx.execute("UPDATE lab_tests SET status = 'ESCALATED', escalated_at = %s, version = %s WHERE id = %s",
                   [now, t["version"] + 1, t["id"]])
        audit.record(tx, action="system.labTestEscalate", entity_type="labTest", entity_id=t["id"], actor=None,
                     diff={"status": [t["status"], "ESCALATED"], "escalatedAt": [None, iso(now)],
                           "version": [t["version"], t["version"] + 1]})
        outbox.enqueue(tx, "lab.escalate", {
            "labTestId": t["id"], "labOrgId": t["lab_org_id"], "batchId": t["batch_id"],
            "publicCode": codes[t["batch_id"]], "dueAt": iso(t["due_at"]), "escalatedAt": iso(now),
        }, request_id=None)
    return len(due)


def run() -> int:
    """One tick; the number of tests escalated."""
    return with_tx(_tick)


JOB = register(Job(NAME, run))
