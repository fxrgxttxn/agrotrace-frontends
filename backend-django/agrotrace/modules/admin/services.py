"""
Administration of organizations (contracts/openapi/paths/admin.yaml, FR-ADM-01, FR-IAM-01; R54/D25–D26, R59), the
port of backend-express/src/modules/admin/service.ts — approveOrganization and updateAdminOrganization here (the
fixtures of almost every tests/api file need them); listAdminOrganizations is Task 4.

Status changes follow contracts/rules/entity-state-machines.json (`organization`). Both operations lock the
organization row first (`FOR NO KEY UPDATE`; R47/R59: `organization` comes after complaint and before batches in the
lock order) and run every check on the locked row. SUSPENDED/REJECTED take effect at sign-in and refresh (auth checks
the status); issued access tokens live out their 15 minutes. A change of name or region drops the public pages that
show the organization after the commit (R82, decision 16); an unchanged update writes no audit row.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from agrotrace.core import audit, config, sql
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import file_urls
from agrotrace.modules.public import cache as public_cache
from agrotrace.security.jwt import Principal


@cache
def _transitions(by: str) -> frozenset[str]:
    rules = json.loads((config.ROOT / "contracts" / "rules" / "entity-state-machines.json").read_text("utf-8"))
    return frozenset(f"{t['from']}>{t['to']}" for t in rules["organization"]["transitions"] if t["by"] == by)


_VIEWS = """
SELECT o.id::text AS id, o.name, o.type, o.logo_file_id::text AS logo_file_id, o.inn, o.address, o.trust_rating,
       o.status, o.created_at, o.updated_at, r.code AS region_code, r.name AS region_name,
       (SELECT count(*) FROM users u WHERE u.organization_id = o.id AND u.deleted_at IS NULL) AS users_count,
       (SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'phone', u.phone)
          FROM users u
         WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.is_org_admin
         ORDER BY u.created_at, u.id LIMIT 1) AS head
  FROM organizations o JOIN regions r ON r.id = o.region_id
 WHERE o.id = ANY(%s::uuid[])
"""


def load_views(ids: list[str]) -> list[dict[str, Any]]:
    """`OrganizationAdmin` views of `ids`, in the order given."""
    if not ids:
        return []
    by_id = {r["id"]: r for r in sql.all(_VIEWS, [ids])}
    out = []
    for i in ids:
        o = by_id.get(i)
        if o is None:
            continue
        head = sql.jsonb(o["head"])
        out.append({
            "id": o["id"],
            "name": o["name"],
            "type": o["type"],
            "logoUrl": file_urls.public_url(o["logo_file_id"]) if o["logo_file_id"] else None,
            "inn": o["inn"],
            "address": o["address"],
            "region": {"code": o["region_code"], "name": o["region_name"]},
            "trustRating": o["trust_rating"] if o["type"] == "FARM" else None,
            "status": o["status"],
            "createdAt": iso(o["created_at"]),
            "updatedAt": iso(o["updated_at"]),
            "usersCount": int(o["users_count"]),
            "head": None if head is None else {
                "id": str(head["id"]),
                "fullName": head["full_name"],
                "email": str(head["email"]).lower(),
                "phone": head["phone"],
            },
        })
    return out


def view(org_id: str) -> dict[str, Any]:
    views = load_views([org_id])
    if not views:
        raise RuntimeError(f"organization {org_id} vanished")
    return views[0]


def lock_organization(tx: Tx, org_id: str) -> dict[str, Any]:
    """The organization row, locked (R47/R59); 404 when missing or deleted."""
    o = tx.one("SELECT id::text AS id, type, name, address, region_id::text AS region_id, status FROM organizations "
               "WHERE id = %s AND deleted_at IS NULL FOR NO KEY UPDATE", [org_id])
    if o is None:
        raise AppProblem(404, "NOT_FOUND")
    return o


def update(p: Principal, org_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Order: 400 body → lock → 404 → 409 INVALID_TRANSITION (a status the machine does not allow, or PLATFORM) →
    400 regionCode notFound."""

    def run(tx: Tx) -> None:
        o = lock_organization(tx, org_id)
        to = body.get("status")
        if to is not None and to != o["status"]:
            if o["type"] == "PLATFORM" or f"{o['status']}>{to}" not in _transitions("updateAdminOrganization"):
                raise AppProblem(409, "INVALID_TRANSITION", params={"from": o["status"], "to": to})
        current = tx.one("SELECT id::text AS id, code FROM regions WHERE id = %s", [o["region_id"]])
        assert current is not None
        region = current
        if "regionCode" in body and body["regionCode"] != current["code"]:
            found = tx.one("SELECT id::text AS id, code FROM regions WHERE code = %s FOR KEY SHARE",
                           [body["regionCode"]])
            if found is None:
                raise validation_problem({"regionCode": ["validation.notFound"]})
            region = found
        before = {"name": o["name"], "address": o["address"], "regionCode": current["code"], "status": o["status"]}
        after = {
            "name": body.get("name", o["name"]),
            "address": body["address"] if "address" in body else o["address"],
            "regionCode": region["code"],
            "status": body.get("status", o["status"]),
        }
        diff = audit.audit_diff(before, after)
        if not diff:
            return
        tx.execute("UPDATE organizations SET name = %s, address = %s, region_id = %s, status = %s, updated_at = now() "
                   "WHERE id = %s", [after["name"], after["address"], region["id"], after["status"], org_id])
        audit.record(tx, action="updateAdminOrganization", entity_type="organization", entity_id=org_id, actor=p,
                     diff=diff)
        if "name" in diff or "regionCode" in diff:
            public_cache.schedule_drop(tx, public_cache.codes_of_org(tx, org_id))

    with_tx(run)
    return view(org_id)


def approve(p: Principal, org_id: str) -> dict[str, Any]:
    """PENDING/MANUAL_CHECK → ACTIVE on the locked row; otherwise 409 {from, to: ACTIVE}."""

    def run(tx: Tx) -> None:
        o = lock_organization(tx, org_id)
        if f"{o['status']}>ACTIVE" not in _transitions("approveOrganization"):
            raise AppProblem(409, "INVALID_TRANSITION", params={"from": o["status"], "to": "ACTIVE"})
        tx.execute("UPDATE organizations SET status = 'ACTIVE', updated_at = now() WHERE id = %s", [org_id])
        audit.record(tx, action="approveOrganization", entity_type="organization", entity_id=org_id, actor=p,
                     diff={"status": [o["status"], "ACTIVE"]})

    with_tx(run)
    return view(org_id)
