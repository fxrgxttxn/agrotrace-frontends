"""
Recalls and recall tasks (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml; БП-5, FR-QA-06/07, BR-08, BR-10,
R47/R52/R54), the port of backend-express/src/modules/recalls/service.ts: the register, the card and the graph
(INSPECTOR, ADMIN), the manual recall (INSPECTOR — the engine, engine.py, at REPEATABLE READ), the tasks (their holders
and INSPECTOR) and their confirmation. Views — mappers.py.

createRecall runs in `with_tx(..., **RECALL_TX)`: REPEATABLE READ (R54/D7) and one more attempt on a deadlock, a
serialization failure or 23505 `ux_recalls_open_source` — two parallel createRecall of one source both answer with the
one recall (D-I3); a send or an accept committed after the snapshot fails the batch lock with 40001 and the repeat sees
it, so the recall never loses to an acceptance (P39: the acceptance answers 422 BR-06 when the recall commits first).

confirmRecallTask locks in the R52 order (P57): the task is read without a lock to learn its recall and batch, then
the recall `FOR NO KEY UPDATE`, the batch `FOR NO KEY UPDATE` (core.locks.lock_batches), the task `FOR NO KEY
UPDATE`; every check from 404 on runs over the locked rows, `If-Match` is compare-and-set on the task. Two
confirmations of one recall serialize on the recall row, so exactly one of them sees every task CONFIRMED and closes
it (BR-10). submitLabResults(FAIL) joining the OPEN recall takes only KEY SHARE on the recall (its FK check), which
NO KEY UPDATE does not conflict with — the two never wait on each other in a cycle (tests/api locks.test.ts).

P43: every instant one operation writes is the transaction's `now()` — the tasks' createdAt = the recall's openedAt
(engine), the recall's closedAt = the closing confirmation's confirmedAt. The public pages of changed batches are
dropped once the connection is back in the pool; `recall.requested` is published by the relay after the commit.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.if_match import check_version
from agrotrace.core.locks import lock_batches
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null
from agrotrace.core.tx import RECALL_TX, Tx, with_tx
from agrotrace.domain.rules import should_close_recall
from agrotrace.modules.batches.lifecycle import notify, transition_batch
from agrotrace.modules.batches.services import invalid_transition
from agrotrace.modules.public import cache
from agrotrace.modules.recalls import engine, mappers
from agrotrace.modules.recalls.serializers import RecallCreate, RecallTaskConfirm
from agrotrace.security.jwt import Principal

RECALL_SORT_FIELDS = ("openedAt", "closedAt")
RECALL_SORT_DEFAULT = "openedAt,desc"
_RECALL_ORDER = {"openedAt": "r.opened_at", "closedAt": "r.closed_at"}
TASK_SORT_FIELDS = ("dueAt", "createdAt", "confirmedAt")
TASK_SORT_DEFAULT = "dueAt,asc"
_TASK_ORDER = {"dueAt": "t.due_at", "createdAt": "t.created_at", "confirmedAt": "t.confirmed_at"}
TRIGGERS = ("LAB", "INSPECTOR", "COMPLAINT")
TASK_STATUSES = ("OPEN", "CONFIRMED", "OVERDUE")

_BATCH_COLUMNS = "b.id::text AS id, b.public_code, b.status, b.version"


def not_found() -> AppProblem:
    return AppProblem(404, "NOT_FOUND")


def _task_audit(t: dict[str, Any]) -> dict[str, Any]:
    return {"status": t["status"], "confirmedAt": iso_or_null(t["confirmed_at"]), "confirmedBy": t["confirmed_by"],
            "version": t["version"]}


def _page(base: str, params: list[Any], order: str, direction: str, page: int, size: int,
          alias: str) -> tuple[list[str], int]:
    total = sql.scalar(f"SELECT count(*) {base}", params)
    d = "ASC" if direction == "asc" else "DESC"
    ids = [r["id"] for r in sql.all(
        f'SELECT {alias}.id::text AS id {base} ORDER BY {order} {d} NULLS LAST, {alias}.id::text COLLATE "C" '
        "LIMIT %s OFFSET %s", [*params, size, (page - 1) * size])]
    return ids, int(total)


# ── listRecalls / getRecall / getRecallGraph ──────────────────────────────────────────────────────────────────────

def list_recalls(request) -> dict[str, Any]:
    """Every non-deleted recall; filters joined by AND (batchId — any member; q — the source's publicCode; from/to —
    the UTC date of openedAt); `x-sort` with nulls last and the id tie-break."""
    q = QueryReader(request)
    page, size, sort = q.page(RECALL_SORT_FIELDS, RECALL_SORT_DEFAULT)
    text = q.q()
    status = q.enum_of("status", ("OPEN", "CLOSED"))
    triggers = q.enum_list("trigger", TRIGGERS)
    batch_id = q.uuid("batchId")
    frm, to = q.date_range()
    q.done()

    conds = ["r.deleted_at IS NULL"]
    params: list[Any] = []
    if status:
        conds.append("r.status = %s")
        params.append(status)
    if triggers:
        conds.append("r.trigger = ANY(%s)")
        params.append(triggers)
    if batch_id:
        conds.append("EXISTS (SELECT 1 FROM recall_batches rb WHERE rb.recall_id = r.id AND rb.batch_id = %s)")
        params.append(batch_id.lower())
    day_conds, day_params = utc_day_bounds("r.opened_at", frm, to)
    conds.extend(day_conds)
    params.extend(day_params)
    if text is not None:
        conds.append("position(lower(%s) in lower(b.public_code)) > 0")
        params.append(text)
    base = f"FROM recalls r JOIN batches b ON b.id = r.source_batch_id WHERE {' AND '.join(conds)}"
    ids, total = _page(base, params, _RECALL_ORDER[sort.field], sort.dir, page, size, "r")
    return {"items": mappers.load_recall_items(ids), "page": page, "size": size, "total": total}


def get_recall(recall_id: str) -> dict[str, Any]:
    r = mappers.load_recall(recall_id)
    if r is None:
        raise not_found()
    return r


def recall_graph(recall_id: str) -> dict[str, Any]:
    g = mappers.load_recall_graph(recall_id)
    if g is None:
        raise not_found()
    return g


# ── createRecall ──────────────────────────────────────────────────────────────────────────────────────────────────

def create_recall(p: Principal, body: Any) -> tuple[int, dict[str, Any]]:
    """body (400) → the source non-deleted (else 400 sourceBatchId notFound; any status) → the engine (trigger
    INSPECTOR, the body's reason and blockUpstream, the user as author). 201 — a new recall; 200 — the OPEN recall of
    the source, unchanged (nothing published)."""
    data = RecallCreate.parse_body(body)
    source = data["sourceBatchId"].lower()

    def run(tx: Tx) -> engine.RecallOutcome:
        if tx.scalar("SELECT id FROM batches WHERE id = %s AND deleted_at IS NULL", [source]) is None:
            raise validation_problem({"sourceBatchId": ["validation.notFound"]})
        out = engine.start_recall(tx, source_batch_id=source, trigger="INSPECTOR", opened_by=p.user_id,
                                  block_upstream=data["blockUpstream"], action="createRecall", reason=data["reason"])
        cache.schedule_drop(tx, out.changed_codes)
        return out

    out = with_tx(run, **RECALL_TX)
    return (201 if out.created else 200), get_recall(out.recall_id)


# ── listRecallTasks / confirmRecallTask ───────────────────────────────────────────────────────────────────────────

def list_tasks(p: Principal, request) -> dict[str, Any]:
    """Holders see their organization's tasks, INSPECTOR every task (R51 for holderOrgId); tasks of soft-deleted
    recalls are seen by nobody."""
    q = QueryReader(request)
    page, size, sort = q.page(TASK_SORT_FIELDS, TASK_SORT_DEFAULT)
    text = q.q()
    statuses = q.enum_list("status", TASK_STATUSES)
    overdue = q.bool("overdue")
    recall_id = q.uuid("recallId")
    inspector = "INSPECTOR" in p.roles
    holder_org_id = None
    if inspector:
        holder_org_id = q.uuid("holderOrgId")
    else:
        q.not_allowed("holderOrgId")
    q.done()

    conds = ["r.deleted_at IS NULL"]
    params: list[Any] = []
    if not inspector:
        conds.append("t.holder_org_id = %s")
        params.append(p.org_id)
    if statuses:
        conds.append("t.status = ANY(%s)")
        params.append(statuses)
    if overdue is not None:
        conds.append(mappers.OVERDUE_SQL if overdue else f"NOT {mappers.OVERDUE_SQL}")
    if recall_id:
        conds.append("t.recall_id = %s")
        params.append(recall_id.lower())
    if holder_org_id:
        conds.append("t.holder_org_id = %s")
        params.append(holder_org_id.lower())
    if text is not None:
        conds.append("position(lower(%s) in lower(b.public_code)) > 0")
        params.append(text)
    base = ("FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id "
            f"WHERE {' AND '.join(conds)}")
    ids, total = _page(base, params, _TASK_ORDER[sort.field], sort.dir, page, size, "t")
    return {"items": mappers.load_task_items(ids), "page": page, "size": size, "total": total}


def _task_version(task_id: str) -> dict[str, Any] | None:
    v = sql.scalar("SELECT version FROM recall_tasks WHERE id = %s", [task_id])
    return {"currentVersion": v} if v is not None else None


def confirm_task(p: Principal, task_id: str, version: int | None, if_match_errors: dict[str, list[str]],
                 body: Any) -> dict[str, Any]:
    """body/If-Match (one 400) → locks (recall → batch → task) → 404 (holder ≠ the user's organization, a deleted
    recall) → If-Match → CONFIRMED → batch not Recalled → the task CONFIRMED, the batch WrittenOff, and — the last open
    task — the recall CLOSED with RECALL CLOSED to the inspectors."""
    RecallTaskConfirm.parse_body({} if body is None else body, extra_errors=if_match_errors)
    assert version is not None

    def run(tx: Tx) -> None:
        t0 = tx.one("SELECT recall_id::text AS recall_id, batch_id::text AS batch_id FROM recall_tasks WHERE id = %s",
                    [task_id])
        if t0 is None:
            raise not_found()
        recall = tx.one("SELECT id::text AS id, status, version, trigger, source_batch_id::text AS source_batch_id, "
                        "deleted_at FROM recalls WHERE id = %s FOR NO KEY UPDATE", [t0["recall_id"]])
        locked = lock_batches(tx, [t0["batch_id"]], _BATCH_COLUMNS)
        t = tx.one("SELECT id::text AS id, holder_org_id::text AS holder_org_id, status, confirmed_at, "
                   "confirmed_by::text AS confirmed_by, version FROM recall_tasks WHERE id = %s FOR NO KEY UPDATE",
                   [task_id])
        if t is None or not locked or recall is None or recall["deleted_at"] is not None or \
                t["holder_org_id"] != p.org_id:
            raise not_found()
        b = locked[0]
        check_version(version, t["version"])
        if t["status"] == "CONFIRMED":
            raise invalid_transition("CONFIRMED", "CONFIRMED")
        if b["status"] != "Recalled":
            raise AppProblem(409, "INVALID_TRANSITION",
                             params={"from": b["status"], "to": "WrittenOff", "publicCode": b["public_code"]})

        now = tx.now
        after = tx.one("UPDATE recall_tasks SET status = 'CONFIRMED', confirmed_at = %s, confirmed_by = %s, "
                       "version = %s WHERE id = %s RETURNING status, confirmed_at, confirmed_by::text AS confirmed_by, "
                       "version", [now, p.user_id, t["version"] + 1, task_id])
        assert after is not None
        audit.record(tx, action="confirmRecallTask", entity_type="recallTask", entity_id=task_id, actor=p,
                     diff=audit.audit_diff(_task_audit(t), _task_audit(after)))
        v = transition_batch(tx, b, "WrittenOff", "WRITTEN_OFF", p.user_id)
        audit.record(tx, action="confirmRecallTask", entity_type="batch", entity_id=b["id"], actor=p,
                     diff={"status": [b["status"], "WrittenOff"], "version": [b["version"], v]})

        statuses = [r["status"] for r in tx.all("SELECT status FROM recall_tasks WHERE recall_id = %s",
                                                [recall["id"]])]
        if recall["status"] == "OPEN" and should_close_recall(statuses):
            tx.execute("UPDATE recalls SET status = 'CLOSED', closed_at = %s, version = %s WHERE id = %s",
                       [now, recall["version"] + 1, recall["id"]])
            audit.record(tx, action="confirmRecallTask", entity_type="recall", entity_id=recall["id"], actor=p,
                         diff={"status": ["OPEN", "CLOSED"], "closedAt": [None, iso(now)],
                               "version": [recall["version"], recall["version"] + 1]})
            code = tx.scalar("SELECT public_code FROM batches WHERE id = %s", [recall["source_batch_id"]])
            notify(tx, "RECALL", roles=["INSPECTOR"], payload={
                "recallId": recall["id"], "event": "CLOSED", "sourceBatchId": recall["source_batch_id"],
                "publicCode": code, "trigger": recall["trigger"]})
        cache.schedule_drop(tx, [b["public_code"]])

    with_tx(run, conflict_params=lambda: _task_version(task_id))
    [view] = mappers.load_task_items([task_id])
    return view
