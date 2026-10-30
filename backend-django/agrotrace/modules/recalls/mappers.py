"""
The contract's recall views (contracts/openapi/schemas/recalls.yaml): `RecallTask`, `RecallListItem`, `Recall`,
`RecallGraph`, `ActorRef` — the port of backend-express/src/modules/recalls/view.ts. `overdue` and `progress.overdue`
are computed at read time by the DB clock: a task not CONFIRMED with now() > due_at, whether or not the scheduler has
set OVERDUE yet. Fixed orders of the contract compare strings by code points (`COLLATE "C"`, P14). Every read is a
statement of its own (core.sql: no pool connection is held between them, P61).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import sql
from agrotrace.core.render import iso, iso_or_null, mass
from agrotrace.infra import file_urls
from agrotrace.modules.batches import mappers as batch_mappers

OVERDUE_SQL = "(t.status <> 'CONFIRMED' AND now() > t.due_at)"


def actor_refs(ids: list[str | None]) -> dict[str, dict[str, Any]]:
    """`ActorRef` of users by id (avatars as signed URLs)."""
    wanted = sorted({i for i in ids if i is not None})
    if not wanted:
        return {}
    rows = sql.all("SELECT id::text AS id, full_name, avatar_file_id::text AS avatar FROM users "
                   "WHERE id = ANY(%s::uuid[])", [wanted])
    return {r["id"]: {"id": r["id"], "fullName": r["full_name"],
                      "avatarUrl": file_urls.signed(r["avatar"]) if r["avatar"] else None} for r in rows}


_TASKS = (
    "SELECT t.id::text AS id, t.recall_id::text AS recall_id, t.batch_id::text AS batch_id, "
    "t.holder_org_id::text AS holder_org_id, t.due_at, t.status, t.escalated_at, t.confirmed_at, "
    f"t.confirmed_by::text AS confirmed_by, t.created_at, t.version, r.reason, {OVERDUE_SQL} AS overdue "
    "FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id WHERE t.id = ANY(%s::uuid[])"
)


def load_task_items(ids: list[str]) -> list[dict[str, Any]]:
    """`RecallTask` of `ids`, in the order of `ids` (missing ids skipped)."""
    if not ids:
        return []
    rows = sql.all(_TASKS, [list(ids)])
    batches = {b["id"]: b for b in batch_mappers.load_list_items(list(dict.fromkeys(r["batch_id"] for r in rows)))}
    holders = batch_mappers.org_refs([r["holder_org_id"] for r in rows])
    actors = actor_refs([r["confirmed_by"] for r in rows])
    by_id = {r["id"]: r for r in rows}
    out = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            continue
        out.append({
            "id": r["id"],
            "recallId": r["recall_id"],
            "recallReason": r["reason"],
            "batch": batches[r["batch_id"]],
            "holder": holders[r["holder_org_id"]],
            "dueAt": iso(r["due_at"]),
            "status": r["status"],
            "overdue": r["overdue"] is True,
            "escalatedAt": iso_or_null(r["escalated_at"]),
            "confirmedAt": iso_or_null(r["confirmed_at"]),
            "confirmedBy": actors.get(r["confirmed_by"]) if r["confirmed_by"] else None,
            "createdAt": iso(r["created_at"]),
            "version": r["version"],
        })
    return out


_RECALLS = (
    "SELECT r.id::text AS id, r.source_batch_id::text AS source_batch_id, r.trigger, r.reason, r.status, "
    "r.block_upstream, r.opened_at, r.closed_at, "
    "(SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id)::int AS total, "
    "(SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED')::int AS confirmed, "
    f"(SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id AND {OVERDUE_SQL})::int AS overdue, "
    "(SELECT count(*) FROM recall_batches rb WHERE rb.recall_id = r.id)::int AS batches_count "
    "FROM recalls r WHERE r.id = ANY(%s::uuid[])"
)


def load_recall_items(ids: list[str]) -> list[dict[str, Any]]:
    """`RecallListItem` of `ids`, in the order of `ids` (missing ids skipped)."""
    if not ids:
        return []
    rows = sql.all(_RECALLS, [list(ids)])
    sources = {b["id"]: b for b in batch_mappers.load_list_items(
        list(dict.fromkeys(r["source_batch_id"] for r in rows)))}
    by_id = {r["id"]: r for r in rows}
    out = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            continue
        out.append({
            "id": r["id"],
            "sourceBatch": sources[r["source_batch_id"]],
            "trigger": r["trigger"],
            "reason": r["reason"],
            "status": r["status"],
            "blockUpstream": r["block_upstream"],
            "openedAt": iso(r["opened_at"]),
            "closedAt": iso_or_null(r["closed_at"]),
            "progress": {"confirmed": r["confirmed"], "total": r["total"], "overdue": r["overdue"]},
            "batchesCount": r["batches_count"],
        })
    return out


def _members(recall_id: str) -> list[dict[str, Any]]:
    """`recall_batches` of the recall in the contract's order: SOURCE, DOWN, UP, then depth, then publicCode."""
    return sql.all(
        "SELECT rb.batch_id::text AS batch_id, rb.direction, rb.depth, rb.status_before FROM recall_batches rb "
        "JOIN batches b ON b.id = rb.batch_id WHERE rb.recall_id = %s "
        "ORDER BY CASE rb.direction WHEN 'SOURCE' THEN 0 WHEN 'DOWN' THEN 1 ELSE 2 END, rb.depth, "
        'b.public_code COLLATE "C", rb.batch_id', [recall_id])


def _task_ids(recall_id: str) -> list[str]:
    """Task ids of the recall in the contract's order: dueAt, then the batch's publicCode."""
    return [r["id"] for r in sql.all(
        "SELECT t.id::text AS id FROM recall_tasks t JOIN batches b ON b.id = t.batch_id WHERE t.recall_id = %s "
        'ORDER BY t.due_at, b.public_code COLLATE "C", t.id::text COLLATE "C"', [recall_id])]


def load_recall(recall_id: str) -> dict[str, Any] | None:
    """The `Recall` card of a non-deleted recall, or None."""
    r = sql.one("SELECT created_by::text AS created_by, lab_test_id::text AS lab_test_id, "
                "complaint_id::text AS complaint_id, version FROM recalls WHERE id = %s AND deleted_at IS NULL",
                [recall_id])
    if r is None:
        return None
    [item] = load_recall_items([recall_id])
    ms = _members(recall_id)
    items = {b["id"]: b for b in batch_mappers.load_list_items([m["batch_id"] for m in ms])}
    actors = actor_refs([r["created_by"]])
    return {
        **item,
        "openedBy": actors.get(r["created_by"]) if r["created_by"] else None,
        "labTestId": r["lab_test_id"],
        "complaintId": r["complaint_id"],
        "batches": [{"batch": items[m["batch_id"]], "direction": m["direction"], "depth": m["depth"],
                     "statusBefore": m["status_before"]} for m in ms],
        "tasks": load_task_items(_task_ids(recall_id)),
        "version": r["version"],
    }


def load_recall_graph(recall_id: str) -> dict[str, Any] | None:
    """`RecallGraph` of a non-deleted recall, or None: the members as nodes (the card's order), the links between
    members as edges by parent then child publicCode (code points)."""
    if sql.scalar("SELECT id FROM recalls WHERE id = %s AND deleted_at IS NULL", [recall_id]) is None:
        return None
    ms = _members(recall_id)
    ids = [m["batch_id"] for m in ms]
    items = {b["id"]: b for b in batch_mappers.load_list_items(ids)}
    tasks = {r["batch_id"]: r["status"] for r in sql.all(
        "SELECT batch_id::text AS batch_id, status FROM recall_tasks WHERE recall_id = %s", [recall_id])}
    edges = [] if not ids else sql.all(
        "SELECT l.parent_batch_id::text AS parent, l.child_batch_id::text AS child, l.mass_used_kg FROM batch_links l "
        "JOIN batches p ON p.id = l.parent_batch_id JOIN batches c ON c.id = l.child_batch_id "
        "WHERE l.parent_batch_id = ANY(%s::uuid[]) AND l.child_batch_id = ANY(%s::uuid[]) "
        'ORDER BY p.public_code COLLATE "C", c.public_code COLLATE "C"', [ids, ids])
    nodes = []
    for m in ms:
        b = items[m["batch_id"]]
        nodes.append({"id": b["id"], "publicCode": b["publicCode"], "product": b["product"], "status": b["status"],
                      "statusBefore": m["status_before"], "holder": b["holder"], "direction": m["direction"],
                      "depth": m["depth"], "taskStatus": tasks.get(b["id"])})
    return {"recallId": recall_id, "nodes": nodes,
            "edges": [{"parent": e["parent"], "child": e["child"], "massUsedKg": mass(e["mass_used_kg"])}
                      for e in edges]}
