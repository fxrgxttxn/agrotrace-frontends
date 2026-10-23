"""
The `recall.requested` handler (worker; contracts/events/recall.requested.schema.json, tag Recalls, R55/R56, R89), the
port of backend-express/src/events/consumers/recall-requested.ts. The recall itself is already committed by the
operation that created it; the handler only fans out, in ONE transaction that starts with the processed_events claim:

  1. RECALL {event: OPENED} to the inspectors, every task holder and the source batch's origin — skipped when the
     recall is no longer OPEN (closed at creation without tasks, BR-10, or every task confirmed before the handler ran)
     or is soft-deleted: its RECALL CLOSED is already written and an OPENED after it would contradict it (R89);
  2. RECALL_TASK {event: CREATED} per task (ordered by id, code points) to its holder;
  3. `rating.recalculate {cause: RECALL_SOURCE, sourceId: recallId}` into the outbox when the source's origin is a
     FARM, with the handled event's requestId (published after the commit by the worker's relay thread; the sweeper
     retries).

Notifications (1) and (2) are written by the storage half of notification.dispatch (modules/notifications/
dispatch.py): IN_APP DELIVERED, EMAIL/TELEGRAM PENDING — their delivery is Task 12's. A redelivered event finds its
claim and creates nothing.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.events.claim import claim
from agrotrace.events.tasks import event_task
from agrotrace.infra import outbox
from agrotrace.modules.notifications.dispatch import insert_notifications


def handle(envelope: dict[str, Any]) -> list[str]:
    """The ids of the PENDING (EMAIL/TELEGRAM) rows written."""
    data = envelope["data"]

    def run(tx: Tx) -> list[str]:
        if not claim(tx, envelope["id"]):
            return []
        r = tx.one(
            "SELECT r.id::text AS id, r.trigger, r.status, r.deleted_at, b.id::text AS batch_id, b.public_code, "
            "b.origin_org_id::text AS origin_org_id, o.type AS origin_type FROM recalls r "
            "JOIN batches b ON b.id = r.source_batch_id JOIN organizations o ON o.id = b.origin_org_id "
            "WHERE r.id = %s", [data["recallId"]])
        if r is None:
            return []
        tasks = tx.all(
            "SELECT t.id::text AS id, t.holder_org_id::text AS holder_org_id, t.batch_id::text AS batch_id, t.due_at, "
            'b.public_code FROM recall_tasks t JOIN batches b ON b.id = t.batch_id WHERE t.recall_id = %s '
            'ORDER BY t.id::text COLLATE "C"', [r["id"]])
        pending: list[str] = []
        if r["status"] == "OPEN" and r["deleted_at"] is None and tasks:
            pending += insert_notifications(
                tx, notification_type="RECALL",
                recipients={"userIds": [], "orgIds": list(dict.fromkeys([*(t["holder_org_id"] for t in tasks),
                                                                         r["origin_org_id"]])),
                            "orgHeadIds": [], "roles": ["INSPECTOR"]},
                payload={"recallId": r["id"], "event": "OPENED", "sourceBatchId": r["batch_id"],
                         "publicCode": r["public_code"], "trigger": r["trigger"]})
        for t in tasks:
            pending += insert_notifications(
                tx, notification_type="RECALL_TASK",
                recipients={"userIds": [], "orgIds": [t["holder_org_id"]], "orgHeadIds": [], "roles": []},
                payload={"recallId": r["id"], "taskId": t["id"], "batchId": t["batch_id"],
                         "publicCode": t["public_code"], "dueAt": iso(t["due_at"]), "event": "CREATED"})
        if r["origin_type"] == "FARM":
            outbox.enqueue(tx, "rating.recalculate", {
                "organizationId": r["origin_org_id"], "cause": "RECALL_SOURCE", "sourceId": r["id"]},
                request_id=envelope.get("requestId"))
        return pending

    return with_tx(run)


@event_task("recall.requested")
def recall_requested(envelope: dict[str, Any]) -> None:
    handle(envelope)
