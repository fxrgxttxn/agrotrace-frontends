"""
Batches (contracts/openapi/paths/batches.yaml; FR-PROD-03, FR-PROD-07, FR-PROD-08, R20, R42–R45, R49, R81), the port of
backend-express/src/modules/batches/{service,path}.ts: list, registration with the BR-03 risk model and the lab
assignment (D18), card, history, path, graph, sale. QR — qr.py; documents — modules/documents. Visibility —
visibility.py (D14).

Locks (R47/R52, P57): createBatch takes the field FOR KEY SHARE (a parallel deleteField either waits or wins, and then
the re-checked row is gone → 400 validation.notFound) and the product FOR SHARE; every operation on an existing batch
locks the batch row FOR NO KEY UPDATE and checks over the locked row. The public page cache `pub:batch:{publicCode}`
is dropped after the commit of every status change (R82).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.if_match import check_version
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null, mass
from agrotrace.core.tx import Tx, with_tx
from agrotrace.core.validation import wire_mass_ok
from agrotrace.domain.rules import risk_model
from agrotrace.domain.state_machine import batch_statuses, can_transition
from agrotrace.infra import file_urls, outbox
from agrotrace.modules.batches import mappers
from agrotrace.modules.batches.lifecycle import transition_batch
from agrotrace.modules.batches.serializers import BatchCreate
from agrotrace.modules.batches.visibility import batch_visible_sql, is_participant, sees_all
from agrotrace.modules.fields.services import lock_field_for_reference
from agrotrace.modules.lab.assign import assign_lab
from agrotrace.modules.public import cache
from agrotrace.security.jwt import Principal

LIST_SORT_FIELDS = ("publicCode", "massKg", "updatedAt", "harvestedAt", "producedAt")
LIST_SORT_DEFAULT = "updatedAt,desc"
_ORDER = {"publicCode": 'b.public_code COLLATE "C"', "massKg": "b.mass_kg", "updatedAt": "b.updated_at",
          "harvestedAt": "b.harvested_at", "producedAt": "b.produced_at"}
_PRODUCED = "(CASE WHEN b.kind = 'RAW' THEN b.harvested_at ELSE b.produced_at END)"
VSD_CATEGORIES = ("DAIRY", "MEAT")

#: The batch row as the services read it (ids as text).
BATCH_COLUMNS = ("b.id::text AS id, b.public_code, b.product_id::text AS product_id, "
                 "b.origin_org_id::text AS origin_org_id, b.holder_org_id::text AS holder_org_id, "
                 "b.field_id::text AS field_id, b.kind, b.mass_kg, b.harvested_at, b.produced_at, b.created_at, "
                 "b.status, b.test_required, b.test_reason, b.version, b.qr_png_file_id::text AS qr_png_file_id, "
                 "b.qr_pdf_file_id::text AS qr_pdf_file_id, b.qr_generated_at")


def not_holder(public_code: str | None = None) -> AppProblem:
    params: dict[str, Any] = {"reason": "NOT_HOLDER"}
    if public_code is not None:
        params["publicCode"] = public_code
    return AppProblem(403, "FORBIDDEN", params=params, title="Not the batch holder")


def invalid_transition(frm: str, to: str) -> AppProblem:
    return AppProblem(409, "INVALID_TRANSITION", params={"from": frm, "to": to})


def batch_audit(b: dict[str, Any]) -> dict[str, Any]:
    """Audit view of a batch row (API names and formats)."""
    return {
        "publicCode": b["public_code"], "productId": b["product_id"], "originOrgId": b["origin_org_id"],
        "holderOrgId": b["holder_org_id"], "fieldId": b["field_id"], "kind": b["kind"], "massKg": mass(b["mass_kg"]),
        "harvestedAt": iso_or_null(b["harvested_at"]), "producedAt": iso_or_null(b["produced_at"]),
        "status": b["status"], "testRequired": b["test_required"], "testReason": b["test_reason"],
        "version": b["version"],
    }


# ── visibility ────────────────────────────────────────────────────────────────────────────────────────────────────

def _visible_query(p: Principal, lock: bool) -> tuple[str, list[Any]]:
    pred, params = batch_visible_sql(p, "b.id")
    q = (f"SELECT {BATCH_COLUMNS}, {pred} AS visible FROM batches b WHERE b.id = %s AND b.deleted_at IS NULL"
         + (" FOR NO KEY UPDATE OF b" if lock else ""))
    return q, params


def visible_batch(p: Principal, batch_id: str) -> dict[str, Any]:
    """The non-deleted batch `batch_id` if `p` sees it, else 404 (outside a transaction)."""
    q, params = _visible_query(p, False)
    b = sql.one(q, [*params, batch_id])
    if b is None or not b["visible"]:
        raise AppProblem(404, "NOT_FOUND")
    return b


def lock_visible_batch(tx: Tx, p: Principal, batch_id: str) -> dict[str, Any]:
    """The batch row locked FOR NO KEY UPDATE first, then the visibility check over the locked row (404)."""
    q, params = _visible_query(p, True)
    b = tx.one(q, [*params, batch_id])
    if b is None or not b["visible"]:
        raise AppProblem(404, "NOT_FOUND")
    return b


def current_version(batch_id: str) -> dict[str, Any] | None:
    v = sql.scalar("SELECT version FROM batches WHERE id = %s", [batch_id])
    return {"currentVersion": v} if v is not None else None


# ── listBatches ───────────────────────────────────────────────────────────────────────────────────────────────────

def list_batches(p: Principal, request) -> dict[str, Any]:
    """Visible batches, filters joined by AND (R49, R51), `x-sort`."""
    q = QueryReader(request)
    page, size, sort = q.page(LIST_SORT_FIELDS, LIST_SORT_DEFAULT)
    text = q.q()
    statuses = q.enum_list("status", batch_statuses())
    product_id = q.uuid("productId")
    holder = q.enum_of("holder", ("me", "all"))
    origin = q.enum_of("origin", ("me", "all"))
    org_id = None
    if sees_all(p):
        org_id = q.uuid("orgId")
    else:
        q.not_allowed("orgId")
    kind = q.enum_of("kind", ("RAW", "DERIVED"))
    frm, to = q.date_range()
    q.done()

    pred, params = batch_visible_sql(p, "b.id")
    conds = ["b.deleted_at IS NULL", pred]
    if statuses:
        conds.append("b.status = ANY(%s)")
        params.append(statuses)
    if product_id:
        conds.append("b.product_id = %s")
        params.append(product_id)
    participant = is_participant(p)
    if holder == "me":
        conds.append("b.holder_org_id = %s" if participant else "false")
        params.extend([p.org_id] if participant else [])
    if origin == "me":
        conds.append("b.origin_org_id = %s" if participant else "false")
        params.extend([p.org_id] if participant else [])
    if org_id:
        conds.append("(b.origin_org_id = %s OR b.holder_org_id = %s)")
        params.extend([org_id, org_id])
    if kind:
        conds.append("b.kind = %s")
        params.append(kind)
    day_conds, day_params = utc_day_bounds(_PRODUCED, frm, to)
    conds.extend(day_conds)
    params.extend(day_params)
    if text is not None:
        conds.append("position(lower(%s) in lower(b.public_code)) > 0")
        params.append(text)
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM batches b WHERE {where}", params)
    direction = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(
        f"SELECT b.id::text AS id FROM batches b WHERE {where} "
        f'ORDER BY {_ORDER[sort.field]} {direction} NULLS LAST, b.id::text COLLATE "C" LIMIT %s OFFSET %s',
        [*params, size, (page - 1) * size],
    )
    return {"items": mappers.load_list_items([r["id"] for r in rows]), "page": page, "size": size,
            "total": int(total)}


# ── createBatch ───────────────────────────────────────────────────────────────────────────────────────────────────

def parse_create(body: Any) -> dict[str, Any]:
    """`BatchCreate`; a mass the schema accepted but not in the wire form (three decimals) → validation.mass.format."""
    ok, value, errors = BatchCreate.validate(body)
    if isinstance(body, dict) and "massKg" not in errors and not wire_mass_ok(body.get("massKg")):
        errors["massKg"] = ["validation.mass.format"]
    if errors:
        raise validation_problem(errors)
    return value


def _ms(dt: datetime) -> datetime:
    return dt.replace(microsecond=dt.microsecond // 1000 * 1000)


def create_batch(p: Principal, body: Any) -> dict[str, Any]:
    """createBatch — one transaction: insert (Created, CREATED by the user) → BR-03 → Approved (TEST_NOT_REQUIRED) or a
    lab test + OnTest (TEST_REQUIRED) + LAB_ASSIGNED; no ACTIVE lab → 409 NO_LAB_AVAILABLE, everything rolled back (the
    code sequence value is spent); DAIRY/MEAT → a PENDING VSD row + `vsd.import` (R81)."""
    data = parse_create(body)
    field_id = data["fieldId"].lower()
    product_id = data["productId"].lower()

    def run(tx: Tx) -> str:
        errors: dict[str, list[str]] = {}
        field = lock_field_for_reference(tx, field_id, p.org_id, strength="key share")
        if field is None:
            errors["fieldId"] = ["validation.notFound"]
        product = tx.one("SELECT id::text AS id, name, category FROM products WHERE id = %s AND deleted_at IS NULL "
                         "FOR SHARE", [product_id])
        if product is None:
            errors["productId"] = ["validation.notFound"]
        elif product["category"] == "PROCESSED":
            errors["productId"] = ["validation.product.category"]
        # Date.parse(harvestedAt) > now (both at millisecond precision, the transaction's clock — P43).
        if tx.scalar("SELECT date_trunc('milliseconds', %s::timestamptz) > date_trunc('milliseconds', now())",
                     [data["harvestedAt"]]):
            errors["harvestedAt"] = ["validation.date.future"]
        if errors:
            raise validation_problem(errors)
        assert field is not None and product is not None
        now = tx.now
        b = tx.one(
            "INSERT INTO batches (public_code, product_id, origin_org_id, holder_org_id, field_id, kind, mass_kg, "
            "harvested_at, status, version, created_by, created_at, updated_at) "
            "VALUES (next_batch_code(), %s, %s, %s, %s, 'RAW', %s, %s::timestamptz, 'Created', 1, %s, %s, %s) "
            f"RETURNING {BATCH_COLUMNS.replace('b.', '')}",
            [product["id"], p.org_id, p.org_id, field["id"], data["massKg"], data["harvestedAt"], p.user_id, now, now],
        )
        assert b is not None
        tx.execute("INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, "
                   "changed_at) VALUES (%s, NULL, 'Created', %s, 'CREATED', %s)", [b["id"], p.user_id, now])

        # BR-03 inputs (contract createBatch step 3); `now` at the millisecond, as Express's clock read.
        now_ms = _ms(now)
        farm_batch_count = tx.scalar(
            "SELECT count(*) FROM batches WHERE origin_org_id = %s AND kind = 'RAW' AND deleted_at IS NULL "
            "AND id <> %s", [p.org_id, b["id"]])
        trust = tx.scalar("SELECT trust_rating FROM organizations WHERE id = %s", [p.org_id])
        pesticides = tx.scalar(
            "SELECT count(*) FROM treatments t JOIN substances s ON s.id = t.substance_id "
            "WHERE t.field_id = %s AND t.deleted_at IS NULL AND s.type = 'PESTICIDE' "
            "AND t.applied_at >= %s AND t.applied_at <= %s",
            [field["id"], now_ms - timedelta(days=30), now_ms])
        required, reason = risk_model(public_code=b["public_code"], farm_batch_count=int(farm_batch_count),
                                      trust_rating=int(trust or 0),
                                      pesticide_treatments_last_30_days=int(pesticides))
        tx.execute("UPDATE batches SET test_required = %s, test_reason = %s WHERE id = %s",
                   [required, reason, b["id"]])

        if not required:
            version = transition_batch(tx, b, "Approved", "TEST_NOT_REQUIRED", None)
            status = "Approved"
        else:
            assign_lab(tx, {"id": b["id"], "public_code": b["public_code"], "origin_org_id": p.org_id,
                            "region_id": field["region_id"], "product_name": product["name"],
                            "test_required": True, "test_reason": reason}, actor=p)
            version = transition_batch(tx, b, "OnTest", "TEST_REQUIRED", None)
            status = "OnTest"
        audit.record(tx, action="createBatch", entity_type="batch", entity_id=b["id"], actor=p,
                     diff=audit.audit_diff(None, batch_audit({**b, "status": status, "version": version,
                                                              "test_required": required, "test_reason": reason})))

        if product["category"] in VSD_CATEGORIES:
            doc_id = tx.scalar("INSERT INTO batch_documents (batch_id, kind, import_status, attempts) "
                               "VALUES (%s, 'VSD', 'PENDING', 0) RETURNING id::text", [b["id"]])
            audit.record(tx, action="createBatch", entity_type="batchDocument", entity_id=doc_id, actor=p,
                         diff=audit.audit_diff(None, {"batchId": b["id"], "kind": "VSD", "importStatus": "PENDING",
                                                      "attempts": 0}))
            outbox.enqueue(tx, "vsd.import", {"documentId": doc_id, "batchId": b["id"],
                                              "publicCode": b["public_code"]})
        return b["id"]

    batch_id = with_tx(run)
    return mappers.load_card(p, batch_id)


# ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────

def get_batch(p: Principal, batch_id: str) -> dict[str, Any]:
    visible_batch(p, batch_id)
    return mappers.load_card(p, batch_id)


def history(p: Principal, batch_id: str) -> list[dict[str, Any]]:
    """getBatchHistory — every row by changed_at, then the insertion order."""
    visible_batch(p, batch_id)
    rows = sql.all(
        "SELECT h.from_status, h.to_status, h.changed_at, h.reason, h.changed_by::text AS changed_by, u.full_name, "
        "u.avatar_file_id::text AS avatar FROM batch_status_history h LEFT JOIN users u ON u.id = h.changed_by "
        "WHERE h.batch_id = %s ORDER BY h.changed_at, h.id", [batch_id])
    return [{
        "from": h["from_status"], "to": h["to_status"], "changedAt": iso(h["changed_at"]), "reason": h["reason"],
        "changedBy": ({"fullName": h["full_name"], "avatarUrl": file_urls.signed(h["avatar"]) if h["avatar"] else None}
                      if h["changed_by"] and h["full_name"] is not None else None),
    } for h in rows]


def path_stages(b: dict[str, Any]) -> list[dict[str, Any]]:
    """The ownership path (R45; getBatchPath and PublicBatch.path): the first stage is the originating organization
    from harvestedAt (RAW) or producedAt (DERIVED); every ACCEPTED, non-deleted waybill with the batch (by acceptedAt,
    then the waybill number by code points) closes the previous stage and opens the receiver's; the current stage
    has `to` = null. Sending and rejection create no stage."""
    accepted = sql.all(
        "SELECT w.number, w.receiver_org_id::text AS receiver, w.accepted_at FROM waybills w "
        "JOIN waybill_items wi ON wi.waybill_id = w.id WHERE wi.batch_id = %s AND w.status = 'ACCEPTED' "
        'AND w.deleted_at IS NULL AND w.accepted_at IS NOT NULL ORDER BY w.accepted_at, w.number COLLATE "C"',
        [b["id"]])
    refs = mappers.org_refs([b["origin_org_id"], *(w["receiver"] for w in accepted)])
    start = b["harvested_at"] if b["kind"] == "RAW" else b["produced_at"]
    steps = [{"org": refs[b["origin_org_id"]], "from": iso(start or b["created_at"]), "to": None,
              "waybillNumber": None}]
    for w in accepted:
        at = iso(w["accepted_at"])
        steps[-1]["to"] = at
        steps.append({"org": refs[w["receiver"]], "from": at, "to": None, "waybillNumber": w["number"]})
    return steps


def path(p: Principal, batch_id: str) -> list[dict[str, Any]]:
    return path_stages(visible_batch(p, batch_id))


_DEPTH = r"^\d{1,2}$"

# One recursive CTE per direction (§7.6): every non-deleted batch reachable in 1..depth links, at its smallest
# distance; a deleted batch is neither included nor traversed.
_REACH = """
WITH RECURSIVE reach(id, d) AS (
  SELECT %s::uuid, 0
  UNION
  SELECT l.{next}, r.d + 1 FROM reach r
    JOIN batch_links l ON l.{this} = r.id
    JOIN batches b ON b.id = l.{next} AND b.deleted_at IS NULL
   WHERE r.d < %s
)
SELECT id::text AS id, min(d) AS d FROM reach WHERE d > 0 GROUP BY id
"""


def graph(p: Principal, batch_id: str, request) -> dict[str, Any]:
    """getBatchGraph (FR-PROD-07, D16): parents (depth < 0) and children (depth > 0) up to `depth` levels each way, every
    node once at its smallest |depth|, no siblings; nodes outside the caller's visibility `accessible: false`; edges =
    links between included nodes. Order: nodes by depth, publicCode; edges by parent then child publicCode."""
    from agrotrace.core.params import parse_query
    from agrotrace.core.patterns import ecma

    raw = parse_query(request.META.get("QUERY_STRING", "")).get("depth")
    depth = 2
    if raw is not None:
        if not isinstance(raw, str) or not ecma(_DEPTH).search(raw) or not 1 <= int(raw) <= 5:
            raise validation_problem({"depth": ["validation.range"]})
        depth = int(raw)
    root = visible_batch(p, batch_id)
    nodes: dict[str, int] = {root["id"]: 0}
    for sign, this, nxt in ((-1, "child_batch_id", "parent_batch_id"), (1, "parent_batch_id", "child_batch_id")):
        for r in sql.all(_REACH.format(this=this, next=nxt), [root["id"], depth]):
            nodes.setdefault(r["id"], sign * int(r["d"]))
    ids = list(nodes)
    pred, params = batch_visible_sql(p, "b.id")
    visible = {r["id"]: bool(r["visible"]) for r in sql.all(
        f"SELECT b.id::text AS id, {pred} AS visible FROM batches b WHERE b.id = ANY(%s::uuid[])", [*params, ids])}
    items = {x["id"]: x for x in mappers.load_list_items(ids)}
    ordered = sorted((i for i in ids if i in items), key=lambda i: (nodes[i], items[i]["publicCode"]))
    links = sql.all(
        "SELECT parent_batch_id::text AS parent, child_batch_id::text AS child, mass_used_kg FROM batch_links "
        "WHERE parent_batch_id = ANY(%s::uuid[]) AND child_batch_id = ANY(%s::uuid[])", [ids, ids])
    links = [lk for lk in links if lk["parent"] in items and lk["child"] in items]
    links.sort(key=lambda lk: (items[lk["parent"]]["publicCode"], items[lk["child"]]["publicCode"]))
    return {
        "rootId": root["id"],
        "depth": depth,
        "nodes": [{"id": i, "publicCode": items[i]["publicCode"], "product": items[i]["product"],
                   "status": items[i]["status"], "holder": items[i]["holder"], "depth": nodes[i],
                   "accessible": visible.get(i) is True} for i in ordered],
        "edges": [{"parent": lk["parent"], "child": lk["child"], "massUsedKg": mass(lk["mass_used_kg"])}
                  for lk in links],
    }


# ── putBatchOnSale / markBatchSold ────────────────────────────────────────────────────────────────────────────────

def _sale(p: Principal, batch_id: str, version: int, to: str, operation_id: str) -> dict[str, Any]:
    """lock → 404 → 403 NOT_HOLDER → If-Match → transition (R20); the public page cache dropped after the commit."""

    def run(tx: Tx) -> None:
        b = lock_visible_batch(tx, p, batch_id)
        if b["holder_org_id"] != p.org_id:
            raise not_holder()
        check_version(version, b["version"])
        if not can_transition(b["status"], to):
            raise invalid_transition(b["status"], to)
        v = transition_batch(tx, b, to, "ON_SALE" if to == "OnSale" else "SOLD", p.user_id)
        audit.record(tx, action=operation_id, entity_type="batch", entity_id=batch_id, actor=p,
                     diff={"status": [b["status"], to], "version": [b["version"], v]})
        cache.schedule_drop(tx, [b["public_code"]])

    with_tx(run, conflict_params=lambda: current_version(batch_id))
    return mappers.load_card(p, batch_id)


def put_on_sale(p: Principal, batch_id: str, version: int) -> dict[str, Any]:
    return _sale(p, batch_id, version, "OnSale", "putBatchOnSale")


def mark_sold(p: Principal, batch_id: str, version: int) -> dict[str, Any]:
    return _sale(p, batch_id, version, "Sold", "markBatchSold")
