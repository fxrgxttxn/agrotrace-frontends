"""
The recall engine core (contract tag Recalls, steps 1–7; P2), the port of backend-express/src/modules/recalls/
engine.ts: synchronous, inside the transaction of the operation that starts it (submitLabResults with FAIL — Task 9;
createRecall — Task 10; decideComplaint with RECALL — Task 11), which runs `with_tx(..., **RECALL_TX)`: REPEATABLE
READ (R54/D7) plus one more attempt on 23505 `ux_recalls_open_source` (D-I3).

  1. an OPEN recall of the source → reused, steps 2–7 skipped (`find_open_recall`); a parallel creation by the same
     source hits `ux_recalls_open_source` → the whole transaction runs once more and finds the recall the other one
     created (RECALL_TX);
  2. `recall_scope`: DOWN — all descendants, depth 1…20; UP — all ancestors (only with `block_upstream`), depth 1…20;
     each batch once at its smallest depth; the walk passes THROUGH soft-deleted batches, which are not members;
  3. the caller locks the source and every member in ONE `FOR NO KEY UPDATE ORDER BY id` (R52 `batches`,
     core.locks.lock_batches) — at REPEATABLE READ a member changed after the snapshot fails the lock with 40001 and
     the transaction is repeated (R47), so a link a parallel processing added, or a send or an accept that committed
     first, is never missed (`start_recall` does steps 1–3 for callers with nothing else to lock);
  4–7. `apply_recall`: the `recalls` row (OPEN, version 1, opened at the transaction's instant), `recall_batches` with
     `status_before` for every member, Recalled transitions (RECALLED, by the requesting user) for the statuses that
     allow it (п. 5.1: Processed, Sold, WrittenOff and Recalled keep theirs and get no task), a task per transitioned
     batch (its holder; InTransit — the receiver of its SENT waybill, T9 note c) due by BR-08; no task → CLOSED at
     once (BR-10: closed_at = opened_at, version 2) with `notification.dispatch` RECALL {event: CLOSED} to the
     inspectors (R59). A NEW recall always writes `recall.requested` (its handler fans out OPENED/CREATED and the
     rating; for a recall already closed it sends no OPENED — R89).

Every instant written is the transaction's `now()` (P43: the tasks' createdAt = openedAt). The audit rows (batch,
recallTask, recall) carry the calling operation as `action` (decision 8 of Express Tasks 8–9). Callers add their own
rows (lab test, complaint), drop the public pages of `changed_codes` after the commit (R82) and publish nothing
themselves (R55).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from agrotrace.core import audit, locks
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx
from agrotrace.domain.dates import recall_task_due_at
from agrotrace.domain.rules import should_close_recall
from agrotrace.domain.state_machine import can_transition
from agrotrace.infra import outbox
from agrotrace.modules.batches.lifecycle import notify, transition_batch

#: Depth bound of the graph walk (п. 7.6).
RECALL_MAX_DEPTH = 20

Trigger = Literal["LAB", "INSPECTOR", "COMPLAINT"]
Direction = Literal["SOURCE", "DOWN", "UP"]

#: The batch row as the engine needs it (the caller's lock; it may already be moved, e.g. OnTest → Blocked).
LOCK_COLUMNS = ("b.id::text AS id, b.public_code, b.status, b.version, b.holder_org_id::text AS holder_org_id, "
                "b.origin_org_id::text AS origin_org_id, b.product_id::text AS product_id, b.deleted_at")


@dataclass(frozen=True)
class ScopeMember:
    batch_id: str
    direction: Direction
    depth: int


@dataclass(frozen=True)
class RecallRequest:
    source_batch_id: str
    trigger: Trigger
    reason: str
    block_upstream: bool
    #: The user whose request opened the recall (`created_by`, the author of the transitions and audit rows).
    opened_by: str | None
    #: operationId for the audit rows.
    action: str
    lab_test_id: str | None = None
    complaint_id: str | None = None


@dataclass(frozen=True)
class RecallOutcome:
    recall_id: str
    #: False — an OPEN recall of the source was reused (steps 2–7 skipped).
    created: bool
    #: Closed at creation (BR-10, no task).
    closed: bool
    #: Batches moved to Recalled — their public pages are dropped after the commit (R82).
    changed_codes: list[str] = field(default_factory=list)
    task_ids: list[str] = field(default_factory=list)
    #: Outbox rows of the recall (`recall.requested` of a new one).
    event_ids: list[str] = field(default_factory=list)


def find_open_recall(tx: Tx, source_batch_id: str) -> str | None:
    """Step 1: the id of the OPEN, non-deleted recall of the source batch, if any (a read in the RR snapshot)."""
    return tx.scalar("SELECT id::text FROM recalls WHERE source_batch_id = %s AND status = 'OPEN' "
                     "AND deleted_at IS NULL", [source_batch_id])


def _walk(direction: Literal["DOWN", "UP"]) -> str:
    frm, to = ("parent_batch_id", "child_batch_id") if direction == "DOWN" else ("child_batch_id", "parent_batch_id")
    return (
        "WITH RECURSIVE walk(id, depth) AS ("
        f" SELECT l.{to}, 1 FROM batch_links l WHERE l.{frm} = %(source)s"
        " UNION"
        f" SELECT l.{to}, w.depth + 1 FROM batch_links l JOIN walk w ON l.{frm} = w.id"
        "  WHERE w.depth < %(max)s"
        ") SELECT w.id::text AS id, min(w.depth)::int AS depth FROM walk w JOIN batches b ON b.id = w.id"
        " WHERE b.deleted_at IS NULL AND w.id <> %(source)s GROUP BY w.id"
    )


def recall_scope(tx: Tx, source_batch_id: str, block_upstream: bool) -> list[ScopeMember]:
    """Step 2 (raw recursive SQL, п. 7.6): the source (SOURCE, 0) and its descendants (DOWN) — plus its ancestors (UP)
    when `block_upstream` — at their smallest depth 1…20; soft-deleted batches are walked through but left out; a
    batch found DOWN is not repeated UP. Ordered by id (code points)."""
    params = {"source": source_batch_id, "max": RECALL_MAX_DEPTH}
    members = [ScopeMember(source_batch_id, "SOURCE", 0)]
    seen = {source_batch_id}
    for r in tx.all(_walk("DOWN"), params):
        seen.add(r["id"])
        members.append(ScopeMember(r["id"], "DOWN", r["depth"]))
    if block_upstream:
        for r in tx.all(_walk("UP"), params):
            if r["id"] not in seen:
                members.append(ScopeMember(r["id"], "UP", r["depth"]))
    return sorted(members, key=lambda m: m.batch_id)


def lock_members(tx: Tx, ids: Sequence[str]) -> dict[str, dict[str, Any]]:
    """Step 3: the batches in ONE `FOR NO KEY UPDATE ORDER BY id` (R52), as id → locked row."""
    return {b["id"]: b for b in locks.lock_batches(tx, ids, LOCK_COLUMNS)}


def _task_holder(tx: Tx, b: Mapping[str, Any], status_before: str) -> str | None:
    """The organization of a batch's recall task: its holder; for InTransit the receiver of its SENT waybill."""
    if status_before == "InTransit":
        receiver = tx.scalar(
            "SELECT w.receiver_org_id::text FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id "
            "WHERE wi.batch_id = %s AND w.status = 'SENT' AND w.deleted_at IS NULL LIMIT 1", [b["id"]])
        if receiver is not None:
            return receiver
    return b["holder_org_id"]


def apply_recall(tx: Tx, req: RecallRequest, members: Sequence[ScopeMember],
                 locked: Mapping[str, Mapping[str, Any]]) -> RecallOutcome:
    """Steps 4–7 over the locked members (`locked` holds every member's locked row, the source included, in its
    current state). Assumes step 1 found no OPEN recall."""
    now = tx.now
    source = locked.get(req.source_batch_id)
    if source is None:
        raise RuntimeError(f"recall source {req.source_batch_id} is not locked")
    recall_id: str = tx.scalar(
        "INSERT INTO recalls (source_batch_id, trigger, reason, status, block_upstream, lab_test_id, complaint_id, "
        "opened_at, version, created_at, updated_at, created_by) "
        "VALUES (%s, %s, %s, 'OPEN', %s, %s, %s, %s, 1, %s, %s, %s) RETURNING id::text",
        [req.source_batch_id, req.trigger, req.reason, req.block_upstream, req.lab_test_id, req.complaint_id, now,
         now, now, req.opened_by])

    due_at = recall_task_due_at(now)
    changed: list[str] = []
    task_ids: list[str] = []
    for m in sorted(members, key=lambda x: x.batch_id):
        b = locked.get(m.batch_id)
        if b is None:  # deleted between the walk and the lock: not a member
            continue
        before = b["status"]
        tx.execute("INSERT INTO recall_batches (recall_id, batch_id, direction, depth, status_before) "
                   "VALUES (%s, %s, %s, %s, %s)", [recall_id, b["id"], m.direction, m.depth, before])
        if not can_transition(before, "Recalled"):
            continue  # Processed, Sold, WrittenOff and Recalled keep their status, without a task (п. 5.1)
        holder = _task_holder(tx, b, before)
        v = transition_batch(tx, dict(b), "Recalled", "RECALLED", req.opened_by)
        changed.append(b["public_code"])
        audit.record(tx, action=req.action, entity_type="batch", entity_id=b["id"], actor=None,
                     actor_id=req.opened_by, diff={"status": [before, "Recalled"], "version": [b["version"], v]})
        if holder is None:
            continue
        task_id: str = tx.scalar(
            "INSERT INTO recall_tasks (recall_id, holder_org_id, batch_id, due_at, status, version, created_at, "
            "updated_at) VALUES (%s, %s, %s, %s, 'OPEN', 1, %s, %s) RETURNING id::text",
            [recall_id, holder, b["id"], due_at, now, now])
        task_ids.append(task_id)
        audit.record(tx, action=req.action, entity_type="recallTask", entity_id=task_id, actor=None,
                     actor_id=req.opened_by, diff=audit.audit_diff(None, {
                         "recallId": recall_id, "batchId": b["id"], "holderOrgId": holder, "dueAt": iso(due_at),
                         "status": "OPEN", "version": 1}))

    closed = should_close_recall(["OPEN"] * len(task_ids))
    if closed:
        tx.execute("UPDATE recalls SET status = 'CLOSED', closed_at = %s, version = 2 WHERE id = %s", [now, recall_id])
    audit.record(tx, action=req.action, entity_type="recall", entity_id=recall_id, actor=None, actor_id=req.opened_by,
                 diff=audit.audit_diff(None, {
                     "sourceBatchId": req.source_batch_id, "trigger": req.trigger, "reason": req.reason,
                     "status": "CLOSED" if closed else "OPEN", "blockUpstream": req.block_upstream,
                     "labTestId": req.lab_test_id, "complaintId": req.complaint_id, "openedAt": iso(now),
                     "closedAt": iso(now) if closed else None, "version": 2 if closed else 1}))
    if closed:
        notify(tx, "RECALL", roles=["INSPECTOR"], payload={
            "recallId": recall_id, "event": "CLOSED", "sourceBatchId": req.source_batch_id,
            "publicCode": source["public_code"], "trigger": req.trigger})
    requested = outbox.enqueue(tx, "recall.requested", {
        "recallId": recall_id, "sourceBatchId": req.source_batch_id, "trigger": req.trigger,
        "openedBy": req.opened_by})
    return RecallOutcome(recall_id, True, closed, changed, task_ids, [requested])


def start_recall(tx: Tx, *, source_batch_id: str, trigger: Trigger, opened_by: str | None, block_upstream: bool,
                 action: str, reason: str, lab_test_id: str | None = None,
                 complaint_id: str | None = None) -> RecallOutcome:
    """Steps 1–7 for an operation that locks nothing else of the batches (createRecall, decideComplaint RECALL): reuse
    → scope → one `FOR NO KEY UPDATE ORDER BY id` over the source and the members → apply. Only inside
    `with_tx(..., **RECALL_TX)`."""
    open_id = find_open_recall(tx, source_batch_id)
    if open_id is not None:
        return RecallOutcome(open_id, False, False)
    members = recall_scope(tx, source_batch_id, block_upstream)
    locked = lock_members(tx, [m.batch_id for m in members])
    req = RecallRequest(source_batch_id=source_batch_id, trigger=trigger, reason=reason,
                        block_upstream=block_upstream, opened_by=opened_by, action=action,
                        lab_test_id=lab_test_id, complaint_id=complaint_id)
    return apply_recall(tx, req, members, locked)
