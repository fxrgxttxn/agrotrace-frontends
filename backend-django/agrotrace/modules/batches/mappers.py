"""
The contract's batch views (schemas/batches.yaml), the port of backend-express/src/modules/batches/view.ts:
`BatchListItem`, `Batch` (the card, with the caller's `actions`), and the shared references `OrganizationRef` and
`ProductRef` (public logo/photo URLs).

`actions` (schema `Batch`): the transitions of contracts/rules/state-machine.json from the current status
(`available_actions`, file order) the caller may perform — ship (FARMER/PROCESSOR holder), accept/reject
(PROCESSOR/RETAILER receiver of a SENT waybill with the batch), process (PROCESSOR holder), putOnSale/sell (RETAILER
holder), recall (INSPECTOR), writeOff (FARMER/PROCESSOR/RETAILER holder of the batch's OPEN/OVERDUE recall task);
never the automatic ones. Business rules are not evaluated here.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import sql
from agrotrace.core.render import iso, iso_or_null, mass
from agrotrace.domain.state_machine import available_actions
from agrotrace.infra import file_urls
from agrotrace.security.jwt import Principal


def org_ref(org_id: str, name: str, type_: str, logo_file_id: str | None) -> dict[str, Any]:
    return {"id": str(org_id), "name": name, "type": type_,
            "logoUrl": file_urls.public_url(str(logo_file_id)) if logo_file_id else None}


def org_refs(ids: list[str]) -> dict[str, dict[str, Any]]:
    """`OrganizationRef` of several organizations by id."""
    wanted = sorted({str(i) for i in ids})
    if not wanted:
        return {}
    rows = sql.all("SELECT id::text AS id, name, type, logo_file_id::text AS logo FROM organizations "
                   "WHERE id = ANY(%s::uuid[])", [wanted])
    return {r["id"]: org_ref(r["id"], r["name"], r["type"], r["logo"]) for r in rows}


_BASE = """
SELECT b.id::text AS id, b.public_code, b.mass_kg, b.status, b.kind, b.harvested_at, b.produced_at, b.updated_at,
       b.qr_generated_at, b.test_required, b.test_reason, b.version,
       b.holder_org_id::text AS holder_org_id, b.origin_org_id::text AS origin_org_id,
       p.id::text AS product_id, p.name AS product_name, p.category AS product_category,
       p.image_file_id::text AS product_image,
       h.name AS holder_name, h.type AS holder_type, h.logo_file_id::text AS holder_logo,
       o.name AS origin_name, o.type AS origin_type, o.logo_file_id::text AS origin_logo,
       f.id::text AS field_id, f.name AS field_name{extra}
  FROM batches b
  JOIN products p ON p.id = b.product_id
  JOIN organizations h ON h.id = b.holder_org_id
  JOIN organizations o ON o.id = b.origin_org_id
  LEFT JOIN fields f ON f.id = b.field_id
"""


def product_ref(product_id: str, name: str, category: str, image: str | None) -> dict[str, Any]:
    return {"id": product_id, "name": name, "category": category,
            "imageUrl": file_urls.public_url(image) if image else None}


def list_item(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "publicCode": r["public_code"],
        "product": product_ref(r["product_id"], r["product_name"], r["product_category"], r["product_image"]),
        "massKg": mass(r["mass_kg"]),
        "status": r["status"],
        "kind": r["kind"],
        "holder": org_ref(r["holder_org_id"], r["holder_name"], r["holder_type"], r["holder_logo"]),
        "origin": org_ref(r["origin_org_id"], r["origin_name"], r["origin_type"], r["origin_logo"]),
        "harvestedAt": iso_or_null(r["harvested_at"]),
        "producedAt": iso_or_null(r["produced_at"]),
        "updatedAt": iso(r["updated_at"]),
        "qrGeneratedAt": iso_or_null(r["qr_generated_at"]),
    }


def load_list_items(ids: list[str]) -> list[dict[str, Any]]:
    """`BatchListItem` of `ids`, in the order of `ids` (missing ids skipped)."""
    if not ids:
        return []
    rows = sql.all(_BASE.format(extra="") + " WHERE b.id = ANY(%s::uuid[])", [list(ids)])
    by_id = {r["id"]: r for r in rows}
    return [list_item(by_id[i]) for i in ids if i in by_id]


def _has(p: Principal, *roles: str) -> bool:
    return any(r in roles for r in p.roles)


def batch_view(r: dict[str, Any], p: Principal) -> dict[str, Any]:
    """The `Batch` card of a row of the card query (`receiver_of_sent`, `task_holder` included) for `p`: `actions` =
    the available transitions ∩ the caller's rights."""
    holder = r["holder_org_id"] == p.org_id

    def may(action: str) -> bool:
        if action == "ship":
            return _has(p, "FARMER", "PROCESSOR") and holder
        if action in ("accept", "reject"):
            return _has(p, "PROCESSOR", "RETAILER") and bool(r["receiver_of_sent"])
        if action == "process":
            return _has(p, "PROCESSOR") and holder
        if action in ("putOnSale", "sell"):
            return _has(p, "RETAILER") and holder
        if action == "recall":
            return _has(p, "INSPECTOR")
        if action == "writeOff":
            return _has(p, "FARMER", "PROCESSOR", "RETAILER") and bool(r["task_holder"])
        return False

    return {
        **list_item(r),
        "field": {"id": r["field_id"], "name": r["field_name"]} if r["field_id"] else None,
        "testRequired": r["test_required"],
        "testReason": r["test_reason"],
        "version": r["version"],
        "actions": [a for a in available_actions(r["status"]) if may(a["action"])],
    }


_CARD_EXTRA = """,
       EXISTS (SELECT 1 FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
                WHERE wi.batch_id = b.id AND w.status = 'SENT' AND w.deleted_at IS NULL
                  AND w.receiver_org_id = %s) AS receiver_of_sent,
       EXISTS (SELECT 1 FROM recall_tasks t WHERE t.batch_id = b.id AND t.holder_org_id = %s
                  AND t.status IN ('OPEN', 'OVERDUE')) AS task_holder"""


def load_card(p: Principal, batch_id: str) -> dict[str, Any]:
    """The `Batch` card of `batch_id` for `p` (the caller checked visibility)."""
    r = sql.one(_BASE.format(extra=_CARD_EXTRA) + " WHERE b.id = %s", [p.org_id, p.org_id, batch_id])
    if r is None:
        raise RuntimeError(f"batch {batch_id} vanished")
    return batch_view(r, p)
