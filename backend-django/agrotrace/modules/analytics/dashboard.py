"""
getDashboard (contracts/openapi/paths/analytics.yaml; schemas InspectorDashboard, OrgDashboard, LabDashboard;
FR-ANL-01…03), the port of backend-express/src/modules/analytics/dashboard.ts. `scope` by the caller's roles (union):
inspector — INSPECTOR, ADMIN; org — FARMER, PROCESSOR, RETAILER (the caller's organization); lab — LAB (the caller's
laboratory); otherwise `errors.scope: [validation.scope.notAllowed]` (R51), in the same 400 as the window's errors.
Every number comes from one READ ONLY REPEATABLE READ snapshot (window.snapshot); "now" is the snapshot's now() (P43).
Deleted rows never count (soft-deleted batches hide their lab tests and recall tasks too; tasks of deleted recalls
too); shares via `ratio_percent2`, ordered by the rounded share (decision 8); hours via `hours` (S whole seconds
`floor(extract(epoch))` / (N × 3600), half up).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from agrotrace.core.params import QueryReader
from agrotrace.core.tx import Tx
from agrotrace.domain.decimal import ratio_percent2
from agrotrace.domain.state_machine import batch_statuses
from agrotrace.modules.analytics.window import Window, resolve, snapshot, too_long
from agrotrace.modules.batches.mappers import org_refs
from agrotrace.security.jwt import Principal

SCOPES = ("inspector", "org", "lab")
SCOPE_ROLES: dict[str, tuple[str, ...]] = {
    "inspector": ("INSPECTOR", "ADMIN"),
    "org": ("FARMER", "PROCESSOR", "RETAILER"),
    "lab": ("LAB",),
}


def hours(seconds: int | str, n: int) -> str | None:
    """`Hours` of a sum of whole seconds over `n` records; None when there are none."""
    if n == 0:
        return None
    return ratio_percent2(int(seconds), n * 360_000)


def _top_shares(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Top 10 by the rounded `share` desc, then `tested` desc, then `name` (code points)."""
    out = [{"key": r["key"], "name": r["name"], "tested": r["tested"], "failed": r["failed"],
            "share": ratio_percent2(r["failed"], r["tested"])} for r in rows]
    out.sort(key=lambda r: (-Decimal(r["share"]), -r["tested"], r["name"].encode("utf-8", "surrogatepass")))
    return out[:10]


#: DONE tests completed in the window, of non-deleted tests of non-deleted batches (parameters: start, end).
DONE_IN = ("lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE' "
           "AND lt.completed_at >= %s::timestamptz AND lt.completed_at < %s::timestamptz")


def _inspector(tx: Tx, w: Window) -> dict[str, Any]:
    s, e = w.bounds()
    total = tx.scalar("SELECT count(*)::int FROM batches WHERE deleted_at IS NULL "
                      "AND created_at >= %s::timestamptz AND created_at < %s::timestamptz", [s, e])
    by_product = tx.all(
        "SELECT p.id::text AS key, p.name, count(*)::int AS tested, "
        "count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed "
        "FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id "
        f"WHERE {DONE_IN} GROUP BY p.id, p.name", [s, e])
    by_farm = tx.all(
        "SELECT o.id::text AS key, o.name, count(*)::int AS tested, "
        "count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed "
        "FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id "
        f"WHERE {DONE_IN} AND b.kind = 'RAW' AND o.type = 'FARM' GROUP BY o.id, o.name", [s, e])
    active = tx.scalar("SELECT count(*)::int FROM recalls WHERE deleted_at IS NULL AND status = 'OPEN'")
    closed = tx.one(
        "SELECT coalesce(sum(floor(extract(epoch FROM closed_at - opened_at)))::bigint, 0)::text AS s, "
        "count(*)::int AS n FROM recalls WHERE deleted_at IS NULL "
        "AND closed_at >= %s::timestamptz AND closed_at < %s::timestamptz", [s, e])
    regions = tx.all(
        "SELECT r.code, r.name, (SELECT count(*)::int FROM lab_tests lt "
        "JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id "
        f"WHERE {DONE_IN} AND lt.conclusion = 'FAIL' AND o.region_id = r.id) AS count "
        'FROM regions r ORDER BY r.code COLLATE "C"', [s, e])
    assert closed is not None
    return {
        "scope": "inspector",
        "period": w.period(),
        "batchesTotal": total,
        "rejectedShare": {"byProduct": _top_shares(by_product), "byFarm": _top_shares(by_farm)},
        "activeRecalls": active,
        "avgRecallHours": hours(closed["s"], closed["n"]),
        "violationsByRegion": [{"code": r["code"], "name": r["name"], "count": r["count"]} for r in regions],
    }


def held_by_status(tx: Tx, org_id: str) -> dict[str, int]:
    """Non-deleted batches the organization holds, by status (OrgDashboard.byStatus, the org report's sheet)."""
    return {r["status"]: r["n"] for r in tx.all(
        "SELECT status, count(*)::int AS n FROM batches WHERE deleted_at IS NULL AND holder_org_id = %s "
        "GROUP BY status", [org_id])}


def _org(tx: Tx, p: Principal, w: Window) -> dict[str, Any]:
    s, e = w.bounds()
    counts = held_by_status(tx, p.org_id)
    lab = tx.one(
        "SELECT count(*) FILTER (WHERE lt.conclusion = 'PASS')::int AS pass, "
        "count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS fail "
        f"FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id WHERE {DONE_IN} AND b.origin_org_id = %s",
        [s, e, p.org_id])
    # Tasks as listRecallTasks shows them: tasks of deleted recalls or deleted batches are not counted.
    tasks = tx.one(
        "SELECT count(*)::int AS open, count(*) FILTER (WHERE now() > t.due_at)::int AS overdue "
        "FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id "
        "WHERE t.holder_org_id = %s AND t.status IN ('OPEN', 'OVERDUE') "
        "AND r.deleted_at IS NULL AND b.deleted_at IS NULL", [p.org_id])
    assert lab is not None and tasks is not None
    return {
        "scope": "org",
        "period": w.period(),
        "organization": org_refs([p.org_id])[p.org_id],
        "byStatus": [{"status": st, "count": counts.get(st, 0)} for st in batch_statuses()],
        "labResults": {"pass": lab["pass"], "fail": lab["fail"]},
        "openTasks": tasks["open"],
        "overdueTasks": tasks["overdue"],
    }


def _lab(tx: Tx, p: Principal, w: Window) -> dict[str, Any]:
    s, e = w.bounds()
    queue = tx.one(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE now() > lt.due_at)::int AS overdue "
        "FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id "
        "WHERE lt.lab_org_id = %s AND lt.deleted_at IS NULL AND b.deleted_at IS NULL "
        "AND lt.status IN ('QUEUED', 'SAMPLED', 'ESCALATED')", [p.org_id])
    done = tx.one(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed, "
        "coalesce(sum(floor(extract(epoch FROM lt.completed_at - lt.created_at)))::bigint, 0)::text AS s "
        f"FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id WHERE {DONE_IN} AND lt.lab_org_id = %s",
        [s, e, p.org_id])
    assert queue is not None and done is not None
    return {
        "scope": "lab",
        "period": w.period(),
        "organization": org_refs([p.org_id])[p.org_id],
        "queue": queue["n"],
        "overdue": queue["overdue"],
        "completed": done["n"],
        "failed": done["failed"],
        "avgHours": hours(done["s"], done["n"]),
    }


def window_params(q: QueryReader) -> tuple[str | None, str | None]:
    """`from`/`to` with the window's rules (`validation.range`, then `validation.range.tooLong`)."""
    frm, to = q.date_range()
    if "from" not in q.errors and too_long(frm, to):
        q.errors["from"] = ["validation.range.tooLong"]
    return frm, to


def get_dashboard(p: Principal, request) -> dict[str, Any]:
    q = QueryReader(request)
    scope = q.enum_of("scope", SCOPES)
    if not q.has("scope"):
        q.errors["scope"] = ["validation.required"]
    if scope and not any(r in SCOPE_ROLES[scope] for r in p.roles):
        q.errors["scope"] = ["validation.scope.notAllowed"]
    params = window_params(q)
    q.done()

    def run(tx: Tx, now) -> dict[str, Any]:
        w = Window(*resolve(params, now))
        if scope == "inspector":
            return _inspector(tx, w)
        if scope == "org":
            return _org(tx, p, w)
        return _lab(tx, p, w)

    return snapshot(run)
