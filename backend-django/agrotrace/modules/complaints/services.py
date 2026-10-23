"""
Complaints (contracts/openapi/paths/complaints.yaml; БП-6, FR-QA-08; entity-state-machines.json `complaint`), only
INSPECTOR — the port of backend-express/src/modules/complaints/service.ts: the list, the card (with the buyer's
contact), review (NEW → IN_REVIEW) and the final decision (NEW | IN_REVIEW → DECIDED): REJECT; LAB_TEST — an unplanned
test like createLabTest with reason COMPLAINT in `labOrgId` (lab.assign.insert_unplanned); RECALL — the recall engine
(trigger COMPLAINT, reason = the comment, complaintId; an OPEN recall of the batch is reused) in
`with_tx(..., **RECALL_TX)` (REPEATABLE READ, D-I3).

Locks (R47, R52): the complaint `FOR NO KEY UPDATE` first; RECALL then the batches in one `FOR NO KEY UPDATE ORDER BY
id` (the engine, step 3). Every check from 404 on runs over the locked complaint. P43: decidedAt is the transaction's
`now()`. The public pages of the batches a recall changed are dropped once the connection is back in the pool; the
engine's events go out through the outbox relay after the commit.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null
from agrotrace.core.tx import RECALL_TX, Tx, with_tx
from agrotrace.domain.state_machine import can_entity_go
from agrotrace.modules.batches import mappers as batch_mappers
from agrotrace.modules.batches.services import invalid_transition
from agrotrace.modules.complaints.serializers import ComplaintReviewRequest, parse_decision
from agrotrace.modules.lab.assign import insert_unplanned
from agrotrace.modules.public import cache
from agrotrace.modules.recalls import engine
from agrotrace.modules.recalls.mappers import actor_refs
from agrotrace.security.jwt import Principal

SORT_FIELDS = ("createdAt", "decidedAt")
SORT_DEFAULT = "createdAt,desc"
_ORDER = {"createdAt": "c.created_at", "decidedAt": "c.decided_at"}
STATUSES = ("NEW", "IN_REVIEW", "DECIDED")
DECISIONS = ("REJECT", "LAB_TEST", "RECALL")

_COLUMNS = ("id::text AS id, batch_id::text AS batch_id, text, status, decision, created_at, decided_at, contact, "
            "decision_comment, inspector_id::text AS inspector_id, lab_test_id::text AS lab_test_id, "
            "recall_id::text AS recall_id, deleted_at")
_LIST_KEYS = ("id", "batch", "text", "status", "decision", "createdAt", "decidedAt")


def not_found() -> AppProblem:
    return AppProblem(404, "NOT_FOUND")


def _audit(r: dict[str, Any]) -> dict[str, Any]:
    return {"status": r["status"], "decision": r["decision"], "decisionComment": r["decision_comment"],
            "inspectorId": r["inspector_id"], "labTestId": r["lab_test_id"], "recallId": r["recall_id"],
            "decidedAt": iso_or_null(r["decided_at"])}


def views(ids: list[str]) -> list[dict[str, Any]]:
    """`Complaint` of `ids`, in that order (missing ids skipped). Every read is a statement of its own (P61)."""
    if not ids:
        return []
    rows = sql.all(f"SELECT {_COLUMNS} FROM complaints WHERE id = ANY(%s::uuid[])", [list(ids)])
    batches = {b["id"]: b for b in batch_mappers.load_list_items([r["batch_id"] for r in rows])}
    actors = actor_refs([r["inspector_id"] for r in rows])
    by_id = {r["id"]: r for r in rows}
    out = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            continue
        out.append({
            "id": r["id"], "batch": batches[r["batch_id"]], "text": r["text"], "status": r["status"],
            "decision": r["decision"], "createdAt": iso(r["created_at"]), "decidedAt": iso_or_null(r["decided_at"]),
            "contact": r["contact"], "decisionComment": r["decision_comment"],
            "inspector": actors.get(r["inspector_id"]) if r["inspector_id"] else None,
            "labTestId": r["lab_test_id"], "recallId": r["recall_id"],
        })
    return out


def card(complaint_id: str) -> dict[str, Any]:
    [v] = views([complaint_id])
    return v


def _lock(tx: Tx, complaint_id: str) -> dict[str, Any]:
    """The non-deleted complaint `FOR NO KEY UPDATE` (R52 `complaint`), else 404."""
    r = tx.one(f"SELECT {_COLUMNS} FROM complaints WHERE id = %s FOR NO KEY UPDATE", [complaint_id])
    if r is None or r["deleted_at"] is not None:
        raise not_found()
    return r


# ── listComplaints / getComplaint ─────────────────────────────────────────────────────────────────────────────────

def list_complaints(request) -> dict[str, Any]:
    """Non-deleted complaints; filters joined by AND (q — the batch publicCode or the text; from/to — the UTC date of
    createdAt); `x-sort` with nulls last and the id tie-break."""
    q = QueryReader(request)
    page, size, sort = q.page(SORT_FIELDS, SORT_DEFAULT)
    text = q.q()
    statuses = q.enum_list("status", STATUSES)
    decisions = q.enum_list("decision", DECISIONS)
    batch_id = q.uuid("batchId")
    frm, to = q.date_range()
    q.done()

    conds = ["c.deleted_at IS NULL"]
    params: list[Any] = []
    if statuses:
        conds.append("c.status = ANY(%s)")
        params.append(statuses)
    if decisions:
        conds.append("c.decision = ANY(%s)")
        params.append(decisions)
    if batch_id:
        conds.append("c.batch_id = %s")
        params.append(batch_id.lower())
    day_conds, day_params = utc_day_bounds("c.created_at", frm, to)
    conds.extend(day_conds)
    params.extend(day_params)
    if text is not None:
        conds.append("(position(lower(%s) in lower(b.public_code)) > 0 OR position(lower(%s) in lower(c.text)) > 0)")
        params.extend([text, text])
    base = f"FROM complaints c JOIN batches b ON b.id = c.batch_id WHERE {' AND '.join(conds)}"
    total = sql.scalar(f"SELECT count(*) {base}", params)
    d = "ASC" if sort.dir == "asc" else "DESC"
    ids = [r["id"] for r in sql.all(
        f'SELECT c.id::text AS id {base} ORDER BY {_ORDER[sort.field]} {d} NULLS LAST, c.id::text COLLATE "C" '
        "LIMIT %s OFFSET %s", [*params, size, (page - 1) * size])]
    items = [{k: v[k] for k in _LIST_KEYS} for v in views(ids)]
    return {"items": items, "page": page, "size": size, "total": int(total)}


def get_complaint(complaint_id: str) -> dict[str, Any]:
    if sql.scalar("SELECT id FROM complaints WHERE id = %s AND deleted_at IS NULL", [complaint_id]) is None:
        raise not_found()
    return card(complaint_id)


# ── startComplaintReview ──────────────────────────────────────────────────────────────────────────────────────────

def review(p: Principal, complaint_id: str, body: Any) -> dict[str, Any]:
    """body (400) → lock → 404 → NEW only → IN_REVIEW, inspector = the user."""
    ComplaintReviewRequest.parse_body({} if body is None else body)

    def run(tx: Tx) -> None:
        r = _lock(tx, complaint_id)
        if not can_entity_go("complaint", r["status"], "IN_REVIEW"):
            raise invalid_transition(r["status"], "IN_REVIEW")
        after = tx.one(f"UPDATE complaints SET status = 'IN_REVIEW', inspector_id = %s WHERE id = %s "
                       f"RETURNING {_COLUMNS}", [p.user_id, complaint_id])
        assert after is not None
        audit.record(tx, action="startComplaintReview", entity_type="complaint", entity_id=complaint_id, actor=p,
                     diff=audit.audit_diff(_audit(r), _audit(after)))

    with_tx(run)
    return card(complaint_id)


# ── decideComplaint ───────────────────────────────────────────────────────────────────────────────────────────────

def decide(p: Principal, complaint_id: str, body: Any) -> dict[str, Any]:
    """body (400, with the decision rules) → lock → 404 → DECIDED → (LAB_TEST) the laboratory (400) → DECIDED with the
    decision's effect. RECALL runs at REPEATABLE READ (the engine)."""
    decision = parse_decision(body)
    kind = decision["decision"]

    def run(tx: Tx) -> None:
        r = _lock(tx, complaint_id)
        if not can_entity_go("complaint", r["status"], "DECIDED"):
            raise invalid_transition(r["status"], "DECIDED")
        b = tx.one("SELECT b.id::text AS id, b.public_code, b.origin_org_id::text AS origin_org_id, "
                   "pr.name AS product_name FROM batches b JOIN products pr ON pr.id = b.product_id WHERE b.id = %s",
                   [r["batch_id"]])
        assert b is not None
        lab_test_id = recall_id = None
        if kind == "LAB_TEST":
            lab = tx.one("SELECT id::text AS id, name, type, status FROM organizations WHERE id = %s "
                         "AND deleted_at IS NULL", [decision["labOrgId"].lower()])
            if lab is None or lab["status"] != "ACTIVE":
                raise validation_problem({"labOrgId": ["validation.notFound"]})
            if lab["type"] != "LAB":
                raise validation_problem({"labOrgId": ["validation.labOrg.type"]})
            lab_test_id = insert_unplanned(tx, batch=b, lab=lab, reason="COMPLAINT", actor=p,
                                           action="decideComplaint")
        if kind == "RECALL":
            out = engine.start_recall(tx, source_batch_id=b["id"], trigger="COMPLAINT", opened_by=p.user_id,
                                      block_upstream=decision["blockUpstream"], action="decideComplaint",
                                      reason=decision["comment"], complaint_id=complaint_id)
            recall_id = out.recall_id
            cache.schedule_drop(tx, out.changed_codes)
        after = tx.one(
            "UPDATE complaints SET status = 'DECIDED', decision = %s, decision_comment = %s, inspector_id = %s, "
            f"decided_at = %s, lab_test_id = %s, recall_id = %s WHERE id = %s RETURNING {_COLUMNS}",
            [kind, decision["comment"], p.user_id, tx.now, lab_test_id, recall_id, complaint_id])
        assert after is not None
        audit.record(tx, action="decideComplaint", entity_type="complaint", entity_id=complaint_id, actor=p,
                     diff=audit.audit_diff(_audit(r), _audit(after)))

    if kind == "RECALL":
        with_tx(run, **RECALL_TX)
    else:
        with_tx(run)
    return card(complaint_id)
