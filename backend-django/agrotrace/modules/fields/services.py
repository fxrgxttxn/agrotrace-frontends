"""
Fields and treatments (contracts/openapi/paths/fields.yaml, treatments.yaml; FR-PROD-01/02, R41/D1, R51, P43, P57),
the port of backend-express/src/modules/fields/service.ts.

Visibility (tag Fields): FARMER — the non-deleted fields of the own farm, the only ones it may change; INSPECTOR and
ADMIN — every non-deleted field, read-only. A treatment is visible with its field. Anything outside that is
indistinguishable from a missing entity (404) — also a foreign field for a FARMER who also holds INSPECTOR when writing
(decision 14). A treatment may be changed while the database time ≤ createdAt + 24 h (`can_edit_treatment`, inclusive;
`created_at` is the transaction's now(), P43), otherwise 403 FORBIDDEN {reason: EDIT_WINDOW_CLOSED, editableUntil}.

Lock strength on the field row (P57 + final m2): deleteField `FOR UPDATE` (it waits for and excludes every reference);
updateField and createTreatment `FOR NO KEY UPDATE`; updateTreatment and createBatch (Task 6) `FOR KEY SHARE`; each
reference lock carries `deleted_at IS NULL` in the query itself, so after waiting for a deleteField PostgreSQL
re-checks the condition on the deleted row and no reference to a deleted field is created.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from agrotrace.core import audit, sql
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso, iso_or_null, js_number_text
from agrotrace.core.tx import Tx, with_tx
from agrotrace.domain.dates import can_edit_treatment, editable_until, epoch_ms
from agrotrace.infra import file_urls
from agrotrace.modules.dictionaries.store import decimal_text
from agrotrace.modules.fields.serializers import TreatmentInput, parse_field_input
from agrotrace.security.jwt import Principal

REGION_CODE = r"^[0-9A-Z-]{1,8}$"
_LAST_TREATMENT = "(SELECT max(t.applied_at) FROM treatments t WHERE t.field_id = f.id AND t.deleted_at IS NULL)"


def _sees_all(p: Principal) -> bool:
    return "INSPECTOR" in p.roles or "ADMIN" in p.roles


# ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────────

_FIELD_VIEWS = f"""
SELECT f.id::text AS id, f.name, f.area_ha, f.geometry, r.code AS region_code, r.name AS region_name,
       o.id::text AS org_id, o.name AS org_name, o.type AS org_type, o.logo_file_id::text AS logo_file_id,
       {_LAST_TREATMENT} AS last_treatment_at,
       (SELECT count(*) FROM treatments t WHERE t.field_id = f.id AND t.deleted_at IS NULL) AS treatments_count
  FROM fields f JOIN regions r ON r.id = f.region_id JOIN organizations o ON o.id = f.organization_id
 WHERE f.id = ANY(%s::uuid[])
"""


def load_field_views(ids: list[str]) -> list[dict[str, Any]]:
    """`Field` views of `ids`, in the order given."""
    if not ids:
        return []
    by_id = {r["id"]: r for r in sql.all(_FIELD_VIEWS, [ids])}
    out = []
    for i in ids:
        f = by_id.get(i)
        if f is None:
            continue
        out.append({
            "id": f["id"], "name": f["name"], "areaHa": decimal_text(f["area_ha"]),
            "region": {"code": f["region_code"], "name": f["region_name"]},
            "geometry": sql.jsonb(f["geometry"]),
            "lastTreatmentAt": iso_or_null(f["last_treatment_at"]),
            "treatmentsCount": int(f["treatments_count"]),
            "organization": {"id": f["org_id"], "name": f["org_name"], "type": f["org_type"],
                             "logoUrl": file_urls.public_url(f["logo_file_id"]) if f["logo_file_id"] else None},
        })
    return out


def _field_view(field_id: str) -> dict[str, Any]:
    views = load_field_views([field_id])
    if not views:
        raise RuntimeError(f"field {field_id} vanished")
    return views[0]


_TREATMENTS = """
SELECT t.id::text AS id, t.field_id::text AS field_id, t.dose, t.dose_unit, t.applied_at, t.created_at,
       s.id::text AS substance_id, s.name AS substance_name, s.type AS substance_type, s.waiting_period_days
  FROM treatments t JOIN substances s ON s.id = t.substance_id
"""


def _treatment_view(t: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": t["id"], "fieldId": t["field_id"],
        "substance": {"id": t["substance_id"], "name": t["substance_name"], "type": t["substance_type"],
                      "waitingPeriodDays": t["waiting_period_days"]},
        "dose": decimal_text(t["dose"]), "doseUnit": t["dose_unit"], "appliedAt": iso(t["applied_at"]),
        "createdAt": iso(t["created_at"]), "editableUntil": iso(editable_until(t["created_at"])),
    }


def _treatment(treatment_id: str) -> dict[str, Any]:
    t = sql.one(_TREATMENTS + " WHERE t.id = %s", [treatment_id])
    assert t is not None
    return _treatment_view(t)


def _treatment_audit(t: dict[str, Any]) -> dict[str, Any]:
    """Audit view of a treatment row (API names; `appliedAt` ISO UTC)."""
    return {"fieldId": str(t["field_id"]), "substanceId": str(t["substance_id"]), "dose": decimal_text(t["dose"]),
            "doseUnit": t["dose_unit"], "appliedAt": iso(t["applied_at"])}


def _canonical(v: Any) -> str:
    """JSON with object keys sorted and numbers as JavaScript writes them — jsonb reorders keys and keeps `30.0` as
    written, so stored and sent geometry compare by content."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (int, float)):
        return js_number_text(v)
    if isinstance(v, list):
        return "[" + ",".join(_canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_canonical(v[k])}" for k in sorted(v)) + "}"
    return json.dumps(v)


# ── locks and checks ──────────────────────────────────────────────────────────────────────────────────────────────

def lock_field_for_reference(tx: Tx, field_id: str, org_id: str | None, *,
                             strength: Literal["key share", "no key update"]) -> dict | None:
    """The non-deleted field `field_id` of the organization `org_id`, locked for a reference to it (P57): `key share`
    — updateTreatment, createBatch; `no key update` — createTreatment. The `deleted_at IS NULL` condition is in the
    locking query, so a reference that waited for a deleteField finds nothing. None — no such field."""
    clause = {"key share": "FOR KEY SHARE", "no key update": "FOR NO KEY UPDATE"}[strength]
    return tx.one("SELECT id::text AS id, region_id::text AS region_id FROM fields "
                  f"WHERE id = %s AND organization_id = %s AND deleted_at IS NULL {clause}", [field_id, org_id])


def _own_field_for_update(tx: Tx, p: Principal, field_id: str, purpose: Literal["update", "delete"]) -> dict:
    """The own farm's non-deleted field, locked — `FOR NO KEY UPDATE` for updateField, `FOR UPDATE` for deleteField
    only (P57) — else 404."""
    clause = "FOR UPDATE OF f" if purpose == "delete" else "FOR NO KEY UPDATE OF f"
    f = tx.one("SELECT f.id::text AS id, f.name, f.area_ha, f.geometry, r.code AS region_code "
               "FROM fields f JOIN regions r ON r.id = f.region_id "
               f"WHERE f.id = %s AND f.organization_id = %s AND f.deleted_at IS NULL {clause}", [field_id, p.org_id])
    if f is None:
        raise AppProblem(404, "NOT_FOUND")
    return f


def _region_id(tx: Tx, code: str) -> str:
    """FOR KEY SHARE: a parallel deleteDictionaryEntry of the region waits and then sees this field (P23)."""
    r = tx.one("SELECT id::text AS id FROM regions WHERE code = %s FOR KEY SHARE", [code])
    if r is None:
        raise validation_problem({"regionCode": ["validation.notFound"]})
    return r["id"]


def _visible_field(p: Principal, field_id: str) -> None:
    """A non-deleted field `p` may see (own farm; every farm for INSPECTOR/ADMIN), else 404."""
    if _sees_all(p):
        f = sql.one("SELECT id FROM fields WHERE id = %s AND deleted_at IS NULL", [field_id])
    else:
        f = sql.one("SELECT id FROM fields WHERE id = %s AND deleted_at IS NULL AND organization_id = %s",
                    [field_id, p.org_id])
    if f is None:
        raise AppProblem(404, "NOT_FOUND")


def _check_treatment_refs(tx: Tx, body: dict[str, Any]) -> None:
    """TreatmentInput references and dates (400, collected): a non-deleted substance (FOR SHARE), appliedAt not in
    the future of the database clock (P43)."""
    errors: dict[str, list[str]] = {}
    s = tx.one("SELECT id FROM substances WHERE id = %s AND deleted_at IS NULL FOR SHARE",
               [body["substanceId"].lower()])
    if s is None:
        errors["substanceId"] = ["validation.notFound"]
    if epoch_ms(body["appliedAt"]) > epoch_ms(tx.now):
        errors["appliedAt"] = ["validation.date.future"]
    if errors:
        raise validation_problem(errors)


# ── fields ────────────────────────────────────────────────────────────────────────────────────────────────────────

def list_fields(p: Principal, request) -> dict[str, Any]:
    """Own farm for FARMER, all for INSPECTOR/ADMIN (`organizationId` only for them, else notAllowed — R51)."""
    q = QueryReader(request)
    page, size, sort = q.page(("name", "areaHa", "lastTreatmentAt", "createdAt"), "name,asc")
    text = q.q()
    region_code = q.matching("regionCode", REGION_CODE)
    organization_id = None
    if _sees_all(p):
        organization_id = q.uuid("organizationId")
    else:
        q.not_allowed("organizationId")
    q.done()

    conds = ["f.deleted_at IS NULL"]
    params: list[Any] = []
    org_id = organization_id if _sees_all(p) else p.org_id
    if org_id:
        conds.append("f.organization_id = %s")
        params.append(org_id)
    if region_code is not None:
        conds.append("f.region_id IN (SELECT id FROM regions WHERE code = %s)")
        params.append(region_code)
    if text is not None:
        conds.append("position(lower(%s) in lower(f.name)) > 0")
        params.append(text)
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM fields f WHERE {where}", params)  # noqa: S608
    order = {"name": 'f.name COLLATE "C"', "areaHa": "f.area_ha", "lastTreatmentAt": _LAST_TREATMENT,
             "createdAt": "f.created_at"}[sort.field]
    direction = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(f"SELECT f.id::text AS id FROM fields f WHERE {where} "  # noqa: S608
                   f'ORDER BY {order} {direction} NULLS LAST, f.id::text COLLATE "C" LIMIT %s OFFSET %s',
                   [*params, size, (page - 1) * size])
    return {"items": load_field_views([r["id"] for r in rows]), "page": page, "size": size, "total": int(total)}


def create_field(p: Principal, body: Any) -> dict[str, Any]:
    """In the user's farm; an unknown regionCode → 400 notFound (after the schema)."""
    data = parse_field_input(body)
    geometry = data.get("geometry")

    def run(tx: Tx) -> str:
        region = _region_id(tx, data["regionCode"])
        f = tx.one("INSERT INTO fields (organization_id, name, area_ha, geometry, region_id, created_by) "
                   "VALUES (%s, %s, %s, %s::jsonb, %s, %s) RETURNING id::text AS id, area_ha",
                   [p.org_id, data["name"], data["areaHa"], json.dumps(geometry) if geometry else None, region,
                    p.user_id])
        assert f is not None
        audit.record(tx, action="createField", entity_type="field", entity_id=f["id"], actor=p,
                     diff=audit.audit_diff(None, {"name": data["name"], "areaHa": decimal_text(f["area_ha"]),
                                                  "regionCode": data["regionCode"], "geometry": geometry,
                                                  "organizationId": p.org_id}))
        return f["id"]

    return _field_view(with_tx(run))


def get_field(p: Principal, field_id: str) -> dict[str, Any]:
    _visible_field(p, field_id)
    return _field_view(field_id)


def update_field(p: Principal, field_id: str, body: Any) -> dict[str, Any]:
    """A full replacement (absent geometry → none); last write wins (no version); nothing changed → no write
    (`updated_at` kept), no audit row."""
    data = parse_field_input(body)
    geometry = data.get("geometry")

    def run(tx: Tx) -> None:
        f = _own_field_for_update(tx, p, field_id, "update")
        region = _region_id(tx, data["regionCode"])
        before = {"name": f["name"], "areaHa": decimal_text(f["area_ha"]), "regionCode": f["region_code"],
                  "geometry": sql.jsonb(f["geometry"])}
        wanted = {"name": data["name"], "areaHa": data["areaHa"], "regionCode": data["regionCode"],
                  "geometry": geometry}
        if _canonical(before) == _canonical(wanted):
            return
        after = tx.one("UPDATE fields SET name = %s, area_ha = %s, region_id = %s, geometry = %s::jsonb, "
                       "updated_at = now() WHERE id = %s RETURNING area_ha, geometry",
                       [data["name"], data["areaHa"], region, json.dumps(geometry) if geometry else None, field_id])
        assert after is not None
        diff = audit.audit_diff(before, {"name": data["name"], "areaHa": decimal_text(after["area_ha"]),
                                         "regionCode": data["regionCode"], "geometry": sql.jsonb(after["geometry"])})
        if diff:
            audit.record(tx, action="updateField", entity_type="field", entity_id=field_id, actor=p, diff=diff)

    with_tx(run)
    return _field_view(field_id)


def delete_field(p: Principal, field_id: str) -> None:
    """Soft; the treatments stay (BR-01 of existing batches), new ones are refused (404)."""

    def run(tx: Tx) -> None:
        _own_field_for_update(tx, p, field_id, "delete")
        now = tx.now
        tx.execute("UPDATE fields SET deleted_at = %s WHERE id = %s", [now, field_id])
        audit.record(tx, action="deleteField", entity_type="field", entity_id=field_id, actor=p,
                     diff={"deletedAt": [None, iso(now)]})

    with_tx(run)


# ── treatments ────────────────────────────────────────────────────────────────────────────────────────────────────

def list_treatments(p: Principal, field_id: str, request) -> dict[str, Any]:
    """The field's non-deleted treatments; `substanceId`; `from`/`to` by the UTC day of appliedAt (R41/D31)."""
    q = QueryReader(request)
    page, size, sort = q.page(("appliedAt", "createdAt"), "appliedAt,desc")
    substance_id = q.uuid("substanceId")
    frm, to = q.date_range()
    q.done()
    _visible_field(p, field_id)

    conds = ["t.field_id = %s", "t.deleted_at IS NULL"]
    params: list[Any] = [field_id]
    if substance_id:
        conds.append("t.substance_id = %s")
        params.append(substance_id)
    day_conds, day_params = utc_day_bounds("t.applied_at", frm, to)
    conds += day_conds
    params += day_params
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM treatments t WHERE {where}", params)  # noqa: S608
    column = "t.created_at" if sort.field == "createdAt" else "t.applied_at"
    direction = "ASC" if sort.dir == "asc" else "DESC"
    ids = [r["id"] for r in sql.all(
        f"SELECT t.id::text AS id FROM treatments t WHERE {where} "  # noqa: S608
        f'ORDER BY {column} {direction}, t.id::text COLLATE "C" LIMIT %s OFFSET %s', [*params, size, (page - 1) * size])]
    by_id = {r["id"]: r for r in sql.all(_TREATMENTS + " WHERE t.id = ANY(%s::uuid[])", [ids])} if ids else {}
    return {"items": [_treatment_view(by_id[i]) for i in ids], "page": page, "size": size, "total": int(total)}


def create_treatment(p: Principal, field_id: str, body: Any) -> dict[str, Any]:
    """Order: body → 404 (the own non-deleted field, locked FOR NO KEY UPDATE) → references/dates (400)."""
    data = TreatmentInput.parse_body(body)

    def run(tx: Tx) -> str:
        if lock_field_for_reference(tx, field_id, p.org_id, strength="no key update") is None:
            raise AppProblem(404, "NOT_FOUND")
        now = tx.now
        _check_treatment_refs(tx, data)
        t = tx.one("INSERT INTO treatments (field_id, substance_id, dose, dose_unit, applied_at, created_at, "
                   "updated_at, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                   "RETURNING id::text AS id, field_id, substance_id, dose, dose_unit, applied_at",
                   [field_id, data["substanceId"].lower(), data["dose"], data["doseUnit"], data["appliedAt"], now, now,
                    p.user_id])
        assert t is not None
        audit.record(tx, action="createTreatment", entity_type="treatment", entity_id=t["id"], actor=p,
                     diff=audit.audit_diff(None, _treatment_audit(t)))
        return t["id"]

    return _treatment(with_tx(run))


def update_treatment(p: Principal, treatment_id: str, body: Any) -> dict[str, Any]:
    """Order: body → 404 (a missing/deleted treatment, or its field deleted or not the user's farm) → 403
    EDIT_WINDOW_CLOSED (now > createdAt + 24 h) → references/dates (400). The window is not extended."""
    data = TreatmentInput.parse_body(body)

    def run(tx: Tx) -> None:
        # Lock order field → treatment (as createTreatment): the field FOR KEY SHARE, so a parallel deleteField
        # (FOR UPDATE) cannot interleave; then the treatment row.
        owner = tx.one("SELECT field_id::text AS field_id FROM treatments WHERE id = %s", [treatment_id])
        field = lock_field_for_reference(tx, owner["field_id"], p.org_id, strength="key share") if owner else None
        if field is None:
            raise AppProblem(404, "NOT_FOUND")
        t = tx.one("SELECT t.id, t.field_id, t.substance_id, t.dose, t.dose_unit, t.applied_at, t.created_at "
                   "FROM treatments t JOIN fields f ON f.id = t.field_id "
                   "WHERE t.id = %s AND t.deleted_at IS NULL AND f.deleted_at IS NULL AND f.organization_id = %s "
                   "FOR NO KEY UPDATE OF t", [treatment_id, p.org_id])
        if t is None:
            raise AppProblem(404, "NOT_FOUND")
        now = tx.now
        if not can_edit_treatment(t["created_at"], now):
            raise AppProblem(403, "FORBIDDEN", title="Edit window closed",
                             params={"reason": "EDIT_WINDOW_CLOSED", "editableUntil": iso(editable_until(t["created_at"]))})
        _check_treatment_refs(tx, data)
        after = tx.one("UPDATE treatments SET substance_id = %s, dose = %s, dose_unit = %s, applied_at = %s, "
                       "updated_at = %s WHERE id = %s RETURNING field_id, substance_id, dose, dose_unit, applied_at",
                       [data["substanceId"].lower(), data["dose"], data["doseUnit"], data["appliedAt"], now,
                        treatment_id])
        assert after is not None
        diff = audit.audit_diff(_treatment_audit(t), _treatment_audit(after))
        if diff:
            audit.record(tx, action="updateTreatment", entity_type="treatment", entity_id=treatment_id, actor=p,
                         diff=diff)

    with_tx(run)
    return _treatment(treatment_id)
