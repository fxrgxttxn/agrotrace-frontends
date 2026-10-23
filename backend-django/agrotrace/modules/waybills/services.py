"""
Waybills (contracts/openapi/paths/waybills.yaml; FR-PROD-04/05, БП-3, R4, R47, R50, R52; the lifecycle
contracts/rules/waybill-state-machine.json), the port of backend-express/src/modules/waybills/service.ts:
DRAFT → send (BR-01, BR-06) → SENT → accept (BR-06, BR-07) | reject (R50c recall task reassignment); a DRAFT may be
deleted.

Visibility (tag Waybills; deleted ones are seen by nobody): FARMER/PROCESSOR/RETAILER — the organization sends it (any
status) or receives it (not DRAFT); INSPECTOR and ADMIN — every non-DRAFT, read-only; LAB — none (x-roles).

Locks (R47/R52, P57): every mutation takes the waybill FOR NO KEY UPDATE first, then its batches in ONE statement
`ORDER BY id`, then (reject) the recall tasks `ORDER BY id`, and runs its checks over the locked rows; If-Match is
compared with the locked waybill's version. Every instant an operation writes is the transaction's `now()` (P43).
The public pages of the moved batches are dropped after the commit, once the connection is back in the pool (P61).
acceptWaybill sends no notification (decision 7 of Express Tasks 6–7).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, locks, sql
from agrotrace.core.if_match import check_version
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null, mass
from agrotrace.core.tx import Tx, with_tx
from agrotrace.core.validation import parse_request_body
from agrotrace.domain.decimal import compare_decimal_strings
from agrotrace.domain.rules import check_discrepancy, check_waiting_period
from agrotrace.domain.state_machine import can_transition, can_waybill_go
from agrotrace.modules.batches import mappers
from agrotrace.modules.batches.lifecycle import notify, transition_batch
from agrotrace.modules.batches.services import not_holder
from agrotrace.modules.batches.visibility import batch_visible_sql, is_participant, sees_all
from agrotrace.modules.public import cache
from agrotrace.modules.waybills.serializers import WaybillAccept, WaybillCreate, WaybillReject
from agrotrace.security.jwt import Principal

LIST_SORT_FIELDS = ("createdAt", "sentAt", "acceptedAt", "number")
LIST_SORT_DEFAULT = "createdAt,desc"
STATUSES = ("DRAFT", "SENT", "ACCEPTED", "REJECTED")
_ORDER = {"createdAt": "w.created_at", "sentAt": "w.sent_at", "acceptedAt": "w.accepted_at",
          "number": 'w.number COLLATE "C"'}

WAYBILL_COLUMNS = ("w.id::text AS id, w.number, w.status, w.sender_org_id::text AS sender_org_id, "
                   "w.receiver_org_id::text AS receiver_org_id, w.created_at, w.sent_at, w.accepted_at, "
                   "w.reject_reason, w.version, w.deleted_at")
_RETURNING = WAYBILL_COLUMNS.replace("w.", "")
_BATCH_LOCK_COLUMNS = ("b.id::text AS id, b.public_code, b.holder_org_id::text AS holder_org_id, "
                       "b.field_id::text AS field_id, b.kind, b.mass_kg, b.status, b.version")


# ── problems ──────────────────────────────────────────────────────────────────────────────────────────────────────

def not_sender() -> AppProblem:
    return AppProblem(403, "FORBIDDEN", params={"reason": "NOT_SENDER"}, title="Not the waybill sender")


def not_receiver() -> AppProblem:
    return AppProblem(403, "FORBIDDEN", params={"reason": "NOT_RECEIVER"}, title="Not the waybill receiver")


def business_rule(rule: str, params: dict[str, Any]) -> AppProblem:
    return AppProblem(422, "BUSINESS_RULE", rule=rule, params=params)


def invalid_transition(params: dict[str, Any]) -> AppProblem:
    """409 INVALID_TRANSITION of the waybill `{from, to}` or of a batch `{from, to, publicCode}`."""
    return AppProblem(409, "INVALID_TRANSITION", params=params)


# ── visibility and views ──────────────────────────────────────────────────────────────────────────────────────────

def _has(p: Principal, *roles: str) -> bool:
    return any(r in roles for r in p.roles)


def can_see(p: Principal, w: dict[str, Any]) -> bool:
    """Whether `p` sees the waybill (tag Waybills)."""
    if w["deleted_at"] is not None:
        return False
    if is_participant(p) and (w["sender_org_id"] == p.org_id
                              or (w["receiver_org_id"] == p.org_id and w["status"] != "DRAFT")):
        return True
    return sees_all(p) and w["status"] != "DRAFT"


def _visible_where(p: Principal) -> tuple[str, list[Any]]:
    """The visibility predicate for lists (alias `w`)."""
    parts: list[str] = []
    params: list[Any] = []
    if is_participant(p):
        parts.append("(w.sender_org_id = %s OR (w.receiver_org_id = %s AND w.status <> 'DRAFT'))")
        params.extend([p.org_id, p.org_id])
    if sees_all(p):
        parts.append("w.status <> 'DRAFT'")
    return ("(" + " OR ".join(parts) + ")", params) if parts else ("false", [])


def _items_of(waybill_ids: list[str], q=sql) -> dict[str, list[dict[str, Any]]]:
    """Items of the waybills with their batches, each list ordered by the batch publicCode (code points)."""
    out: dict[str, list[dict[str, Any]]] = {}
    if not waybill_ids:
        return out
    rows = q.all(
        "SELECT wi.waybill_id::text AS waybill_id, wi.batch_id::text AS batch_id, b.public_code, wi.mass_declared_kg, "
        "wi.mass_actual_kg, wi.discrepancy_act FROM waybill_items wi JOIN batches b ON b.id = wi.batch_id "
        "WHERE wi.waybill_id = ANY(%s::uuid[])", [list(waybill_ids)])
    for r in rows:
        out.setdefault(r["waybill_id"], []).append(r)
    for items in out.values():
        items.sort(key=lambda r: r["public_code"])  # Python str order = code points
    return out


def _actions(p: Principal, w: dict[str, Any]) -> list[str]:
    if w["status"] == "DRAFT" and w["sender_org_id"] == p.org_id and _has(p, "FARMER", "PROCESSOR"):
        return ["send", "delete"]
    if w["status"] == "SENT" and w["receiver_org_id"] == p.org_id and _has(p, "PROCESSOR", "RETAILER"):
        return ["accept", "reject"]
    return []


def _item_view(i: dict[str, Any], batch: dict[str, Any]) -> dict[str, Any]:
    declared = mass(i["mass_declared_kg"])
    actual = mass(i["mass_actual_kg"]) if i["mass_actual_kg"] is not None else None
    d = check_discrepancy(declared, actual) if actual is not None else None
    return {
        "batch": batch,
        "massDeclaredKg": declared,
        "massActualKg": actual,
        "discrepancyPercent": d["percent"] if d and "percent" in d else None,
        "discrepancyAct": i["discrepancy_act"],
    }


def load_views(p: Principal, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The `Waybill` views of the rows for `p` (each statement returns its connection at once)."""
    items = _items_of([w["id"] for w in rows])
    batch_ids = list(dict.fromkeys(i["batch_id"] for lst in items.values() for i in lst))
    batches = {b["id"]: b for b in mappers.load_list_items(batch_ids)}
    orgs = mappers.org_refs([x for w in rows for x in (w["sender_org_id"], w["receiver_org_id"])])
    return [{
        "id": w["id"],
        "number": w["number"],
        "status": w["status"],
        "sender": orgs[w["sender_org_id"]],
        "receiver": orgs[w["receiver_org_id"]],
        "items": [_item_view(i, batches[i["batch_id"]]) for i in items.get(w["id"], [])],
        "createdAt": iso(w["created_at"]),
        "sentAt": iso_or_null(w["sent_at"]),
        "acceptedAt": iso_or_null(w["accepted_at"]),
        "rejectReason": w["reject_reason"],
        "version": w["version"],
        "actions": _actions(p, w),
    } for w in rows]


def _view(p: Principal, waybill_id: str) -> dict[str, Any]:
    w = sql.one(f"SELECT {WAYBILL_COLUMNS} FROM waybills w WHERE w.id = %s", [waybill_id])
    assert w is not None
    return load_views(p, [w])[0]


def waybill_audit(w: dict[str, Any]) -> dict[str, Any]:
    return {"status": w["status"], "version": w["version"], "sentAt": iso_or_null(w.get("sent_at")),
            "acceptedAt": iso_or_null(w.get("accepted_at")), "rejectReason": w.get("reject_reason")}


def current_version(waybill_id: str) -> dict[str, Any] | None:
    v = sql.scalar("SELECT version FROM waybills WHERE id = %s", [waybill_id])
    return {"currentVersion": v} if v is not None else None


# ── locks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def lock_batches(tx: Tx, ids: list[str]) -> list[dict[str, Any]]:
    """The batches FOR NO KEY UPDATE in ONE statement `ORDER BY id` (core.locks.lock_batches); missing ids are absent."""
    return locks.lock_batches(tx, ids, _BATCH_LOCK_COLUMNS)


def _lock_all(tx: Tx, p: Principal, waybill_id: str) -> tuple[dict[str, Any], list[tuple[dict, dict]]]:
    """The waybill FOR NO KEY UPDATE (404 when `p` does not see it), then its batches (R52). Items in publicCode
    order, each with its locked batch."""
    w = tx.one(f"SELECT {WAYBILL_COLUMNS} FROM waybills w WHERE w.id = %s FOR NO KEY UPDATE", [waybill_id])
    if w is None or not can_see(p, w):
        raise AppProblem(404, "NOT_FOUND")
    items = _items_of([waybill_id], tx).get(waybill_id, [])
    locked = {b["id"]: b for b in lock_batches(tx, [i["batch_id"] for i in items])}
    return w, [(i, locked[i["batch_id"]]) for i in items]


def _by_id(pairs: list[tuple[dict, dict]]) -> list[tuple[dict, dict]]:
    """The items in the order of their batch ids (code points) — the order of the batch writes."""
    return sorted(pairs, key=lambda ib: ib[1]["id"])


# ── listWaybills / getWaybill ─────────────────────────────────────────────────────────────────────────────────────

def list_waybills(p: Principal, request) -> dict[str, Any]:
    """direction (participants only, R51), status, counterpartyOrgId, from/to by the UTC date of createdAt, q."""
    q = QueryReader(request)
    page, size, sort = q.page(LIST_SORT_FIELDS, LIST_SORT_DEFAULT)
    text = q.q()
    direction = None
    if is_participant(p):
        direction = q.enum_of("direction", ("incoming", "outgoing"))
    else:
        q.not_allowed("direction")
    statuses = q.enum_list("status", STATUSES)
    counterparty = q.uuid("counterpartyOrgId")
    frm, to = q.date_range()
    q.done()

    pred, params = _visible_where(p)
    conds = ["w.deleted_at IS NULL", pred]
    if direction == "outgoing":
        conds.append("w.sender_org_id = %s")
        params.append(p.org_id)
    if direction == "incoming":
        conds.append("w.receiver_org_id = %s")
        params.append(p.org_id)
    if statuses:
        conds.append("w.status = ANY(%s)")
        params.append(statuses)
    if counterparty:
        if is_participant(p):
            conds.append("CASE WHEN w.sender_org_id = %s THEN w.receiver_org_id ELSE w.sender_org_id END = %s")
            params.extend([p.org_id, counterparty])
        else:
            conds.append("(w.sender_org_id = %s OR w.receiver_org_id = %s)")
            params.extend([counterparty, counterparty])
    day_conds, day_params = utc_day_bounds("w.created_at", frm, to)
    conds.extend(day_conds)
    params.extend(day_params)
    if text is not None:
        conds.append("(position(lower(%s) in lower(w.number)) > 0 OR EXISTS (SELECT 1 FROM waybill_items wi "
                     "JOIN batches b ON b.id = wi.batch_id WHERE wi.waybill_id = w.id "
                     "AND position(lower(%s) in lower(b.public_code)) > 0))")
        params.extend([text, text])
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM waybills w WHERE {where}", params)
    direction_sql = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(
        f"SELECT {WAYBILL_COLUMNS} FROM waybills w WHERE {where} "
        f'ORDER BY {_ORDER[sort.field]} {direction_sql} NULLS LAST, w.id::text COLLATE "C" LIMIT %s OFFSET %s',
        [*params, size, (page - 1) * size])
    return {"items": load_views(p, rows), "page": page, "size": size, "total": int(total)}


def get_waybill(p: Principal, waybill_id: str) -> dict[str, Any]:
    w = sql.one(f"SELECT {WAYBILL_COLUMNS} FROM waybills w WHERE w.id = %s", [waybill_id])
    if w is None or not can_see(p, w):
        raise AppProblem(404, "NOT_FOUND")
    return load_views(p, [w])[0]


# ── createWaybill ─────────────────────────────────────────────────────────────────────────────────────────────────

def create_waybill(p: Principal, body: Any) -> dict[str, Any]:
    """body (400; a repeated batch is step 2, P36) → lock the existing batches of the items `ORDER BY id` → references
    (one 400 with every error) → NOT_HOLDER by request order → a DRAFT with `next_waybill_number()`, version 1."""
    data = parse_request_body(WaybillCreate, body, masses=[("items", "massDeclaredKg")], defer_duplicates=["items"])
    receiver_id = data["receiverOrgId"].lower()
    items = data["items"]
    ids = [it["batchId"].lower() for it in items]

    def run(tx: Tx) -> str:
        locked = lock_batches(tx, ids)
        errors: dict[str, list[str]] = {}
        receiver = tx.one("SELECT id::text AS id, type, status FROM organizations WHERE id = %s AND deleted_at IS NULL",
                          [receiver_id])
        if receiver is None or receiver["status"] != "ACTIVE":
            errors["receiverOrgId"] = ["validation.notFound"]
        elif receiver["type"] not in ("PROCESSOR", "RETAILER"):
            errors["receiverOrgId"] = ["validation.receiver.type"]
        elif receiver["id"] == p.org_id:
            errors["receiverOrgId"] = ["validation.receiver.self"]
        visible: set[str] = set()
        if locked:
            pred, params = batch_visible_sql(p, "b.id")
            visible = {r["id"] for r in tx.all(
                f"SELECT b.id::text AS id FROM batches b WHERE b.id = ANY(%s::uuid[]) AND b.deleted_at IS NULL "
                f"AND {pred}", [[b["id"] for b in locked], *params])}
        by_id = {b["id"]: b for b in locked}
        seen: set[str] = set()
        for i, (it, bid) in enumerate(zip(items, ids, strict=True)):
            if bid in seen:
                errors[f"items[{i}].batchId"] = ["validation.duplicate"]
                continue
            seen.add(bid)
            b = by_id.get(bid)
            if b is None or bid not in visible:
                errors[f"items[{i}].batchId"] = ["validation.notFound"]
                continue
            if compare_decimal_strings(it["massDeclaredKg"], b["mass_kg"]) > 0:
                errors[f"items[{i}].massDeclaredKg"] = ["validation.mass.exceedsBatch"]
        if errors:
            raise validation_problem(errors)
        for bid in ids:
            if by_id[bid]["holder_org_id"] != p.org_id:
                raise not_holder(by_id[bid]["public_code"])
        now = tx.now
        w = tx.one("INSERT INTO waybills (number, sender_org_id, receiver_org_id, status, version, created_by, "
                   "created_at, updated_at) VALUES (next_waybill_number(), %s, %s, 'DRAFT', 1, %s, %s, %s) "
                   "RETURNING id::text AS id, number", [p.org_id, receiver_id, p.user_id, now, now])
        assert w is not None
        for it, bid in zip(items, ids, strict=True):
            tx.execute("INSERT INTO waybill_items (waybill_id, batch_id, mass_declared_kg) VALUES (%s, %s, %s)",
                       [w["id"], bid, it["massDeclaredKg"]])
        audit.record(tx, action="createWaybill", entity_type="waybill", entity_id=w["id"], actor=p,
                     diff=audit.audit_diff(None, {
                         "number": w["number"], "senderOrgId": p.org_id, "receiverOrgId": receiver_id,
                         "status": "DRAFT", "version": 1,
                         "items": [{"batchId": bid, "massDeclaredKg": it["massDeclaredKg"]}
                                   for it, bid in zip(items, ids, strict=True)],
                     }))
        return w["id"]

    waybill_id = with_tx(run)
    return _view(p, waybill_id)


# ── deleteWaybill ─────────────────────────────────────────────────────────────────────────────────────────────────

def delete_waybill(p: Principal, waybill_id: str, version: int) -> None:
    """lock → 404 (a DRAFT is seen by its sender only) → NOT_SENDER → If-Match → DRAFT only."""

    def run(tx: Tx) -> None:
        w = tx.one(f"SELECT {WAYBILL_COLUMNS} FROM waybills w WHERE w.id = %s FOR NO KEY UPDATE", [waybill_id])
        if w is None or not can_see(p, w):
            raise AppProblem(404, "NOT_FOUND")
        if w["sender_org_id"] != p.org_id:
            raise not_sender()
        check_version(version, w["version"])
        if not can_waybill_go(w["status"], "DELETED"):
            raise invalid_transition({"from": w["status"], "to": "DELETED"})
        now = tx.now
        tx.execute("UPDATE waybills SET deleted_at = %s WHERE id = %s", [now, waybill_id])
        audit.record(tx, action="deleteWaybill", entity_type="waybill", entity_id=waybill_id, actor=p,
                     diff={"deletedAt": [None, iso(now)]})

    with_tx(run, conflict_params=lambda: current_version(waybill_id))


# ── sendWaybill ───────────────────────────────────────────────────────────────────────────────────────────────────

def send_waybill(p: Principal, waybill_id: str, version: int) -> dict[str, Any]:
    """locks waybill → batches; 404 → NOT_SENDER → If-Match → DRAFT; then per item in publicCode order: NOT_HOLDER,
    BR-06 (Blocked/Recalled), INVALID_TRANSITION (not Approved/Accepted), BR-01 for RAW batches (shipDate = the UTC
    date of the transaction's instant). Result: SENT, batches InTransit (WAYBILL_SENT), WAYBILL_INCOMING to the
    receiver, public pages dropped."""

    def run(tx: Tx) -> None:
        w, pairs = _lock_all(tx, p, waybill_id)
        if w["sender_org_id"] != p.org_id:
            raise not_sender()
        check_version(version, w["version"])
        if not can_waybill_go(w["status"], "SENT"):
            raise invalid_transition({"from": w["status"], "to": "SENT"})
        now = tx.now
        ship_date = iso(now)[:10]
        for _item, b in pairs:
            if b["holder_org_id"] != p.org_id:
                raise not_holder(b["public_code"])
            if b["status"] in ("Blocked", "Recalled"):
                raise business_rule("BR-06", {"publicCode": b["public_code"], "status": b["status"]})
            if not can_transition(b["status"], "InTransit"):
                raise invalid_transition({"from": b["status"], "to": "InTransit", "publicCode": b["public_code"]})
            if b["kind"] == "RAW" and b["field_id"]:
                treatments = tx.all(
                    "SELECT s.name, t.applied_at, s.waiting_period_days FROM treatments t "
                    "JOIN substances s ON s.id = t.substance_id WHERE t.field_id = %s AND t.deleted_at IS NULL",
                    [b["field_id"]])
                br01 = check_waiting_period(ship_date, [
                    {"substance": t["name"], "appliedAt": iso(t["applied_at"]),
                     "waitingPeriodDays": t["waiting_period_days"]} for t in treatments])
                if not br01["ok"]:
                    raise business_rule("BR-01", {"publicCode": b["public_code"], "until": br01["until"],
                                                  "substance": br01["substance"]})
        sent = tx.one(f"UPDATE waybills SET status = 'SENT', sent_at = %s, version = %s WHERE id = %s "
                      f"RETURNING {_RETURNING}", [now, w["version"] + 1, waybill_id])
        assert sent is not None
        audit.record(tx, action="sendWaybill", entity_type="waybill", entity_id=waybill_id, actor=p,
                     diff=audit.audit_diff(waybill_audit(w), waybill_audit(sent)))
        for _item, b in _by_id(pairs):
            v = transition_batch(tx, b, "InTransit", "WAYBILL_SENT", p.user_id)
            audit.record(tx, action="sendWaybill", entity_type="batch", entity_id=b["id"], actor=p,
                         diff={"status": [b["status"], "InTransit"], "version": [b["version"], v]})
        sender = tx.one("SELECT id::text AS id, name FROM organizations WHERE id = %s", [p.org_id])
        assert sender is not None
        notify(tx, "WAYBILL_INCOMING", org_ids=[w["receiver_org_id"]], payload={
            "waybillId": waybill_id, "number": w["number"], "senderOrgId": sender["id"],
            "senderName": sender["name"], "itemsCount": len(pairs)})
        cache.schedule_drop(tx, [b["public_code"] for _i, b in pairs])

    with_tx(run, conflict_params=lambda: current_version(waybill_id))
    return _view(p, waybill_id)


# ── acceptWaybill ─────────────────────────────────────────────────────────────────────────────────────────────────

def accept_waybill(p: Principal, waybill_id: str, version: int | None, if_match_errors: dict[str, list[str]],
                   body: Any) -> dict[str, Any]:
    """locks; 404 → NOT_RECEIVER → If-Match → SENT → items match the waybill (400 items.mismatch; a repeat is this
    step, P36) → per item: BR-06, INVALID_TRANSITION (not InTransit), BR-07 (act required above 2%). Result: ACCEPTED,
    items keep massActualKg/discrepancyAct, batches Accepted with the receiver as holder and the actual mass. A race
    with createRecall: the recall wins — the accept then meets a Recalled batch: 422 BR-06 (P39)."""
    data = parse_request_body(WaybillAccept, body, masses=[("items", "massActualKg")], defer_duplicates=["items"],
                              extra_errors=if_match_errors)
    assert version is not None
    given = data["items"]
    by_batch = {it["batchId"].lower(): it for it in given}

    def run(tx: Tx) -> None:
        w, pairs = _lock_all(tx, p, waybill_id)
        if w["receiver_org_id"] != p.org_id:
            raise not_receiver()
        check_version(version, w["version"])
        if not can_waybill_go(w["status"], "ACCEPTED"):
            raise invalid_transition({"from": w["status"], "to": "ACCEPTED"})
        if (len(by_batch) != len(given) or len(by_batch) != len(pairs)
                or any(b["id"] not in by_batch for _i, b in pairs)):
            raise validation_problem({"items": ["validation.items.mismatch"]})
        for item, b in pairs:
            if b["status"] in ("Blocked", "Recalled"):
                raise business_rule("BR-06", {"publicCode": b["public_code"], "status": b["status"]})
            if b["status"] != "InTransit" or not can_transition(b["status"], "Accepted"):
                raise invalid_transition({"from": b["status"], "to": "Accepted", "publicCode": b["public_code"]})
            a = by_batch[b["id"]]
            d = check_discrepancy(mass(item["mass_declared_kg"]), a["massActualKg"])
            if "percent" in d and d["actRequired"] and "discrepancyAct" not in a:
                raise business_rule("BR-07", {"publicCode": b["public_code"], "percent": d["percent"]})
        now = tx.now
        accepted = tx.one(f"UPDATE waybills SET status = 'ACCEPTED', accepted_at = %s, version = %s WHERE id = %s "
                          f"RETURNING {_RETURNING}", [now, w["version"] + 1, waybill_id])
        assert accepted is not None
        audit.record(tx, action="acceptWaybill", entity_type="waybill", entity_id=waybill_id, actor=p,
                     diff=audit.audit_diff(waybill_audit(w), waybill_audit(accepted)))
        for _item, b in _by_id(pairs):
            a = by_batch[b["id"]]
            tx.execute("UPDATE waybill_items SET mass_actual_kg = %s, discrepancy_act = %s "
                       "WHERE waybill_id = %s AND batch_id = %s",
                       [a["massActualKg"], a.get("discrepancyAct"), waybill_id, b["id"]])
            v = transition_batch(tx, b, "Accepted", "WAYBILL_ACCEPTED", p.user_id,
                                 {"holder_org_id": p.org_id, "mass_kg": a["massActualKg"]})
            audit.record(tx, action="acceptWaybill", entity_type="batch", entity_id=b["id"], actor=p,
                         diff=audit.audit_diff(
                             {"status": b["status"], "version": b["version"], "holderOrgId": b["holder_org_id"],
                              "massKg": mass(b["mass_kg"])},
                             {"status": "Accepted", "version": v, "holderOrgId": p.org_id,
                              "massKg": a["massActualKg"]}))
        cache.schedule_drop(tx, [b["public_code"] for _i, b in pairs])

    with_tx(run, conflict_params=lambda: current_version(waybill_id))
    return _view(p, waybill_id)


# ── rejectWaybill ─────────────────────────────────────────────────────────────────────────────────────────────────

def reject_waybill(p: Principal, waybill_id: str, version: int | None, if_match_errors: dict[str, list[str]],
                   body: Any) -> dict[str, Any]:
    """body → locks (waybill, batches, then the receiver's open recall tasks on recalled batches, R52) → 404 →
    NOT_RECEIVER → If-Match → SENT. InTransit batches back to Approved (WAYBILL_REJECTED); a batch recalled in
    transit: its OPEN/OVERDUE task held by the receiver goes to the sender (dueAt kept, version + 1) with RECALL_TASK
    {event: REASSIGNED} to the sender (R50c)."""
    data = parse_request_body(WaybillReject, body, extra_errors=if_match_errors)
    assert version is not None

    def run(tx: Tx) -> None:
        w, pairs = _lock_all(tx, p, waybill_id)
        if w["receiver_org_id"] != p.org_id:
            raise not_receiver()
        check_version(version, w["version"])
        if not can_waybill_go(w["status"], "REJECTED"):
            raise invalid_transition({"from": w["status"], "to": "REJECTED"})
        recalled = [b["id"] for _i, b in pairs if b["status"] == "Recalled"]
        tasks: list[dict[str, Any]] = []
        if recalled:
            task_ids = [r["id"] for r in tx.all(
                "SELECT id::text AS id FROM recall_tasks WHERE batch_id = ANY(%s::uuid[]) AND holder_org_id = %s "
                "AND status IN ('OPEN', 'OVERDUE')", [recalled, w["receiver_org_id"]])]
            if task_ids:
                tasks = tx.all(
                    "SELECT id::text AS id, recall_id::text AS recall_id, batch_id::text AS batch_id, "
                    "holder_org_id::text AS holder_org_id, status, due_at, version FROM recall_tasks "
                    "WHERE id = ANY(%s::uuid[]) ORDER BY id FOR NO KEY UPDATE", [sorted(task_ids)])
        rejected = tx.one(f"UPDATE waybills SET status = 'REJECTED', reject_reason = %s, version = %s WHERE id = %s "
                          f"RETURNING {_RETURNING}", [data["reason"], w["version"] + 1, waybill_id])
        assert rejected is not None
        audit.record(tx, action="rejectWaybill", entity_type="waybill", entity_id=waybill_id, actor=p,
                     diff=audit.audit_diff(waybill_audit(w), waybill_audit(rejected)))
        changed: list[str] = []
        for _item, b in _by_id(pairs):
            if b["status"] != "InTransit" or not can_transition(b["status"], "Approved"):
                continue
            v = transition_batch(tx, b, "Approved", "WAYBILL_REJECTED", p.user_id)
            changed.append(b["public_code"])
            audit.record(tx, action="rejectWaybill", entity_type="batch", entity_id=b["id"], actor=p,
                         diff={"status": [b["status"], "Approved"], "version": [b["version"], v]})
        code_of = {b["id"]: b["public_code"] for _i, b in pairs}
        for t in tasks:
            # Still open and still the receiver's after the lock (a parallel confirm or reassignment wins).
            if t["holder_org_id"] != w["receiver_org_id"] or t["status"] not in ("OPEN", "OVERDUE"):
                continue
            tx.execute("UPDATE recall_tasks SET holder_org_id = %s, version = %s WHERE id = %s",
                       [w["sender_org_id"], t["version"] + 1, t["id"]])
            audit.record(tx, action="rejectWaybill", entity_type="recallTask", entity_id=t["id"], actor=p,
                         diff={"holderOrgId": [t["holder_org_id"], w["sender_org_id"]],
                               "version": [t["version"], t["version"] + 1]})
            notify(tx, "RECALL_TASK", org_ids=[w["sender_org_id"]], payload={
                "recallId": t["recall_id"], "taskId": t["id"], "batchId": t["batch_id"],
                "publicCode": code_of.get(t["batch_id"]), "dueAt": iso(t["due_at"]), "event": "REASSIGNED"})
        cache.schedule_drop(tx, changed)

    with_tx(run, conflict_params=lambda: current_version(waybill_id))
    return _view(p, waybill_id)
