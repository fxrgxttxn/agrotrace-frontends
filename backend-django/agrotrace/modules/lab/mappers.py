"""
Lab test views (contracts/openapi/schemas/lab.yaml: `LabTestListItem`, `LabTest`) and visibility (tag Lab), the port of
backend-express/src/modules/lab/view.ts: deleted tests (and tests of deleted batches) are seen by nobody;
INSPECTOR/ADMIN — all; LAB — its own laboratory's tests; FARMER/PROCESSOR/RETAILER — the tests of the batches they see
(tag Batches, S ∪ N), computed WITHOUT the LAB role (a LAB role adds nothing there; decision 5 of Express Tasks 8–9).
`overdue` is computed at read time by the DB clock: an open status and now() > due_at.

`norms`: while not DONE — the current norms of the batch's product with non-deleted indicators; for DONE — the snapshot
of the results (maxValue = normValue); both ordered by indicator name (code points), then indicatorId. Every read is a
statement of its own (core.sql: no pool connection is held between them).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from agrotrace.core import sql
from agrotrace.core.render import iso, iso_or_null
from agrotrace.modules.batches import mappers as batch_mappers
from agrotrace.modules.batches.visibility import batch_visible_sql, is_participant, sees_all
from agrotrace.modules.files.services import file_url
from agrotrace.security.jwt import Principal

#: Statuses whose results can still be submitted (entity-state-machines.json labTest → DONE).
LAB_OPEN = ("QUEUED", "SAMPLED", "ESCALATED")
OVERDUE_SQL = "(t.status IN ('QUEUED', 'SAMPLED', 'ESCALATED') AND now() > t.due_at)"


def decimal_text(v: Decimal | str) -> str:
    """A numeric(14,6) value as PostgreSQL prints it (its scale kept, never an exponent)."""
    return format(v, "f") if isinstance(v, Decimal) else v


def visible_sql(p: Principal) -> tuple[str, list[Any]]:
    """The visibility predicate of the test `t` (deletion is the caller's filter)."""
    if sees_all(p):
        return "true", []
    parts: list[str] = []
    params: list[Any] = []
    if "LAB" in p.roles:
        parts.append("t.lab_org_id = %s")
        params.append(p.org_id)
    if is_participant(p):
        pred, pred_params = batch_visible_sql(p, "t.batch_id", lab=False)
        parts.append(pred)
        params.extend(pred_params)
    if not parts:
        return "false", []
    return "(" + " OR ".join(parts) + ")", params


_ROWS = (
    "SELECT t.id::text AS id, t.batch_id::text AS batch_id, t.lab_org_id::text AS lab_org_id, t.reason, t.status, "
    "t.conclusion, t.due_at, t.created_at, t.sampled_at, t.completed_at, t.escalated_at, t.recall_id::text AS recall_id, "
    "t.version, b.product_id::text AS product_id, f.id::text AS file_id, f.kind AS file_kind, f.mime AS file_mime, "
    f"f.size_bytes AS file_size, f.original_name AS file_name, {OVERDUE_SQL} AS overdue "
    "FROM lab_tests t JOIN batches b ON b.id = t.batch_id "
    "LEFT JOIN files f ON f.id = t.protocol_file_id AND f.deleted_at IS NULL "
    "WHERE t.id = ANY(%s::uuid[])"
)


def _items(ids: list[str]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """(row, LabTestListItem) of `ids`, in the order of `ids` (missing ids skipped)."""
    if not ids:
        return []
    rows = sql.all(_ROWS, [list(ids)])
    batches = {b["id"]: b for b in batch_mappers.load_list_items(list(dict.fromkeys(r["batch_id"] for r in rows)))}
    labs = batch_mappers.org_refs([r["lab_org_id"] for r in rows])
    by_id = {r["id"]: r for r in rows}
    out = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            continue
        out.append((r, {
            "id": r["id"],
            "batch": batches[r["batch_id"]],
            "lab": labs[r["lab_org_id"]],
            "reason": r["reason"],
            "status": r["status"],
            "conclusion": r["conclusion"],
            "dueAt": iso(r["due_at"]),
            "overdue": r["overdue"] is True,
            "createdAt": iso(r["created_at"]),
            "sampledAt": iso_or_null(r["sampled_at"]),
            "completedAt": iso_or_null(r["completed_at"]),
            "hasProtocol": r["file_id"] is not None,
        }))
    return out


def load_items(ids: list[str]) -> list[dict[str, Any]]:
    """`LabTestListItem` of `ids`, in the order of `ids`."""
    return [item for _r, item in _items(ids)]


def current_norms(product_id: str, q: Any = sql) -> list[dict[str, Any]]:
    """The current norms of a product (non-deleted indicators), by indicator name (code points), then id. `q` — the
    statement runner (`sql`, or the transaction's `Tx`)."""
    rows = q.all(
        "SELECT i.id::text AS id, i.name, i.unit, n.max_value FROM norms n JOIN indicators i ON i.id = n.indicator_id "
        "WHERE n.product_id = %s AND i.deleted_at IS NULL ORDER BY i.name COLLATE \"C\", i.id::text COLLATE \"C\"",
        [product_id])
    return [{"indicatorId": r["id"], "name": r["name"], "unit": r["unit"], "maxValue": decimal_text(r["max_value"])}
            for r in rows]


def actions(p: Principal, r: dict[str, Any]) -> list[str]:
    """LabTestActionName: the role LAB of the test's own laboratory (the operations answer 404 to anybody else)."""
    out: list[str] = []
    if "LAB" in p.roles and r["lab_org_id"] == p.org_id:
        if r["status"] == "QUEUED":
            out.append("sample")
        if r["status"] in LAB_OPEN:
            out.append("submitResults")
        if r["status"] != "CANCELLED":
            out.append("uploadProtocol")
    return out


def load_card(p: Principal, test_id: str) -> dict[str, Any]:
    """The `LabTest` card of `test_id` for `p` (the caller checked visibility)."""
    found = _items([test_id])
    if not found:
        raise RuntimeError(f"lab test {test_id} vanished")
    r, item = found[0]
    results: list[dict[str, Any]] = []
    if r["status"] == "DONE":
        results = [{
            "indicatorId": x["id"], "name": x["name"], "unit": x["unit"], "value": decimal_text(x["value"]),
            "normValue": decimal_text(x["norm_value_snapshot"] if x["norm_value_snapshot"] is not None else x["value"]),
            "isExceeded": x["is_exceeded"],
        } for x in sql.all(
            "SELECT i.id::text AS id, i.name, i.unit, lr.value, lr.norm_value_snapshot, lr.is_exceeded "
            "FROM lab_results lr JOIN indicators i ON i.id = lr.indicator_id WHERE lr.lab_test_id = %s "
            "ORDER BY i.name COLLATE \"C\", i.id::text COLLATE \"C\"", [test_id])]
        norms = [{"indicatorId": x["indicatorId"], "name": x["name"], "unit": x["unit"], "maxValue": x["normValue"]}
                 for x in results]
    else:
        norms = current_norms(r["product_id"])
    protocol = None
    if r["file_id"] is not None:
        protocol = {"id": r["file_id"], "url": file_url(r["file_kind"], r["file_id"]), "mime": r["file_mime"],
                    "sizeBytes": int(r["file_size"]), "originalName": r["file_name"]}
    return {
        **item,
        "escalatedAt": iso_or_null(r["escalated_at"]),
        "results": results,
        "protocol": protocol,
        "norms": norms,
        "recallId": r["recall_id"],
        "version": r["version"],
        "actions": actions(p, r),
    }
