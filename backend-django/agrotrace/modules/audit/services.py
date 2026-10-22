"""
listAuditLog (contracts/openapi/paths/audit.yaml, spec 8.8), the port of backend-express/src/modules/audit/service.ts
(the reading side; the writer is core.audit): every row for ADMIN and INSPECTOR alike; filters actorId, entityType,
entityId, action (exact), backend, from/to (UTC days of createdAt, inclusive); sorted by createdAt, ties by id
ascending in both directions (decision 15 of Express Tasks 4–5).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import sql
from agrotrace.core.audit import ENTITY_TYPES
from agrotrace.core.params import QueryReader, day_after, day_start
from agrotrace.core.render import iso
from agrotrace.infra import file_urls

BACKENDS = ("express", "django", "laravel", "seed", "system")

_ROWS = """
SELECT a.id, a.actor_id::text AS actor_id, a.action, a.entity_type, a.entity_id::text AS entity_id, a.diff,
       host(a.ip) AS ip, a.backend, a.request_id, a.created_at, u.full_name, o.id::text AS org_id,
       o.name AS org_name, o.type AS org_type, o.logo_file_id::text AS logo_file_id
  FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN organizations o ON o.id = u.organization_id
"""


def list_audit_log(request) -> dict[str, Any]:
    q = QueryReader(request)
    page, size, sort = q.page(("createdAt",), "createdAt,desc")
    actor_id = q.uuid("actorId")
    entity_type = q.enum_of("entityType", ENTITY_TYPES)
    entity_id = q.uuid("entityId")
    action = q.text("action", 64)
    backend = q.enum_of("backend", BACKENDS)
    frm, to = q.date_range()
    q.done()

    conds = ["TRUE"]
    params: list[Any] = []
    for column, value in (("a.actor_id", actor_id), ("a.entity_type", entity_type), ("a.entity_id", entity_id),
                          ("a.action", action), ("a.backend", backend)):
        if value is not None:
            conds.append(f"{column} = %s")
            params.append(value)
    if frm is not None:
        conds.append("a.created_at >= %s")
        params.append(day_start(frm))
    if to is not None:
        conds.append("a.created_at < %s")
        params.append(day_after(to))
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM audit_log a WHERE {where}", params)  # noqa: S608
    direction = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(f"{_ROWS} WHERE {where} ORDER BY a.created_at {direction}, a.id ASC LIMIT %s OFFSET %s",  # noqa: S608
                   [*params, size, (page - 1) * size])
    items = []
    for r in rows:
        actor = None
        if r["actor_id"] and r["full_name"] is not None and r["org_id"] is not None:
            actor = {"id": r["actor_id"], "fullName": r["full_name"],
                     "organization": {"id": r["org_id"], "name": r["org_name"], "type": r["org_type"],
                                      "logoUrl": file_urls.public_url(r["logo_file_id"]) if r["logo_file_id"] else None}}
        items.append({"id": int(r["id"]), "actor": actor, "action": r["action"], "entityType": r["entity_type"],
                      "entityId": r["entity_id"], "diff": sql.jsonb(r["diff"]), "ip": r["ip"], "backend": r["backend"],
                      "requestId": r["request_id"], "createdAt": iso(r["created_at"])})
    return {"items": items, "page": page, "size": size, "total": int(total)}
