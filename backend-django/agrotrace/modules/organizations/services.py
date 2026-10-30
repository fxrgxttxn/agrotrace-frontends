"""
Organizations (contracts/openapi/paths/organizations.yaml), the port of backend-express/src/modules/organizations/
service.ts.

Visibility of a card (п. 4.2, decisions 1–3 of Express Task 3): a participant sees the own organization and its direct
suppliers and receivers — the counterparties of waybills it can see (as sender: any status; as receiver: not DRAFT);
INSPECTOR and ADMIN see every organization; deleted organizations are invisible to all. An invisible organization is
indistinguishable from a missing one (404). The directory (listOrganizations, R46) is not limited by visibility: every
ACTIVE organization except PLATFORM. Text sorting is byte order (`COLLATE "C"`, P14).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.multipart import Upload
from agrotrace.core.params import QueryReader
from agrotrace.core.problem import AppProblem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import file_urls
from agrotrace.infra.images import RASTER_TYPES
from agrotrace.modules.files import services as files
from agrotrace.modules.public import cache as public_cache
from agrotrace.security.jwt import Principal

LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_TYPES = (*RASTER_TYPES, "image/svg+xml")
ORG_TYPES = ("FARM", "PROCESSOR", "LAB", "RETAILER", "AUTHORITY", "PLATFORM")


def sees_all(p: Principal) -> bool:
    return "INSPECTOR" in p.roles or "ADMIN" in p.roles


def visible_org_ids(p: Principal, column: str = "o.id") -> tuple[str, list[Any]]:
    """A SQL condition (and its parameters) true for the organizations `p` may see — `column` names the organization
    id (deleted organizations are filtered by the caller)."""
    if sees_all(p):
        return "true", []
    return (
        f"({column} = %s OR EXISTS (SELECT 1 FROM waybills w WHERE w.deleted_at IS NULL "
        f"AND ((w.sender_org_id = %s AND w.receiver_org_id = {column}) "
        f"OR (w.receiver_org_id = %s AND w.sender_org_id = {column} AND w.status <> 'DRAFT'))))",
        [p.org_id, p.org_id, p.org_id],
    )


def can_see(p: Principal, org_id: str) -> bool:
    cond, params = visible_org_ids(p)
    return bool(sql.scalar(
        f"SELECT EXISTS (SELECT 1 FROM organizations o WHERE o.id = %s AND o.deleted_at IS NULL AND {cond})",
        [org_id, *params]))


def visible_or_404(p: Principal, org_id: str) -> None:
    if not can_see(p, org_id):
        raise AppProblem(404, "NOT_FOUND")


def get(p: Principal, org_id: str) -> dict[str, Any]:
    visible_or_404(p, org_id)
    o = sql.one(
        "SELECT o.id::text AS id, o.name, o.type, o.logo_file_id::text AS logo_file_id, o.inn, o.address, "
        "o.trust_rating, o.status, r.code AS region_code, r.name AS region_name "
        "FROM organizations o JOIN regions r ON r.id = o.region_id WHERE o.id = %s",
        [org_id],
    )
    assert o is not None
    return {
        "id": o["id"],
        "name": o["name"],
        "type": o["type"],
        "logoUrl": file_urls.public_url(o["logo_file_id"]) if o["logo_file_id"] else None,
        "inn": o["inn"],
        "address": o["address"],
        "region": {"code": o["region_code"], "name": o["region_name"]},
        "trustRating": o["trust_rating"] if o["type"] == "FARM" else None,
        "status": o["status"],
    }


def directory(request) -> dict[str, Any]:
    """ACTIVE, not PLATFORM; `type` (repeated); `q` = name or INN prefix, case-insensitive."""
    q = QueryReader(request)
    page, size, sort = q.page(("name",), "name,asc")
    text = q.q()
    types = q.enum_list("type", ORG_TYPES)
    q.done()
    where = ["o.status = 'ACTIVE'", "o.type <> 'PLATFORM'", "o.deleted_at IS NULL"]
    params: list[Any] = []
    if types:
        where.append("o.type = ANY(%s)")
        params.append(types)
    if text is not None:
        where.append("(starts_with(lower(o.name), lower(%s)) OR starts_with(o.inn, %s))")
        params += [text, text]
    cond = " AND ".join(where)
    total = sql.scalar(f"SELECT count(*) FROM organizations o JOIN regions r ON r.id = o.region_id WHERE {cond}",
                       params)
    direction = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(
        "SELECT o.id::text AS id, o.name, o.type, o.logo_file_id::text AS logo_file_id, r.code AS region_code, "
        f"r.name AS region_name FROM organizations o JOIN regions r ON r.id = o.region_id WHERE {cond} "
        f'ORDER BY o.name COLLATE "C" {direction}, o.id::text COLLATE "C" LIMIT %s OFFSET %s',
        [*params, size, (page - 1) * size],
    )
    items = [{"id": o["id"], "name": o["name"], "type": o["type"],
              "logoUrl": file_urls.public_url(o["logo_file_id"]) if o["logo_file_id"] else None,
              "region": {"code": o["region_code"], "name": o["region_name"]}} for o in rows]
    return {"items": items, "page": page, "size": size, "total": int(total)}


def upload_logo(p: Principal, org_id: str, upload: Upload) -> dict[str, Any]:
    """404 for an invisible organization, 403 for a visible foreign one (heads: own only; ADMIN: any), then the file
    (415); the old logo is soft-deleted and the public batch pages that show the organization are dropped from the
    cache after the commit (R82 `pub:batch:*`, decision 14)."""
    visible_or_404(p, org_id)
    if "ADMIN" not in p.roles and org_id != p.org_id:
        raise AppProblem(403, "FORBIDDEN")
    f = files.prepare(upload, kind="LOGO", owner_id=p.user_id, allowed=LOGO_TYPES)
    files.store_objects(f)

    def run(tx: Tx) -> None:
        o = tx.one("SELECT logo_file_id::text AS logo_file_id FROM organizations WHERE id = %s AND deleted_at IS NULL "
                   "FOR NO KEY UPDATE", [org_id])
        if o is None:
            raise AppProblem(404, "NOT_FOUND")
        now = tx.now
        files.insert(tx, f)
        tx.execute("UPDATE organizations SET logo_file_id = %s, updated_at = %s WHERE id = %s", [f.id, now, org_id])
        audit.record(tx, action="uploadOrganizationLogo", entity_type="file", entity_id=f.id, actor=p,
                     diff=audit.audit_diff(None, files.audit_view(f)))
        audit.record(tx, action="uploadOrganizationLogo", entity_type="organization", entity_id=org_id, actor=p,
                     diff={"logoFileId": [o["logo_file_id"], f.id]})
        if files.soft_delete(tx, o["logo_file_id"], now):
            audit.record(tx, action="uploadOrganizationLogo", entity_type="file", entity_id=o["logo_file_id"],
                         actor=p, diff={"deletedAt": [None, iso(now)]})
        public_cache.schedule_drop(tx, public_cache.codes_of_org(tx, org_id))

    with_tx(run)
    return files.file_ref(f)


def logo_file(p: Principal, org_id: str) -> dict[str, Any]:
    """The current logo of a visible organization (404: invisible, missing, no logo)."""
    visible_or_404(p, org_id)
    f = sql.one(f"SELECT {files.columns('f')} FROM organizations o JOIN files f ON f.id = o.logo_file_id "
                "WHERE o.id = %s AND f.deleted_at IS NULL", [org_id])
    if f is None:
        raise AppProblem(404, "NOT_FOUND")
    return f
