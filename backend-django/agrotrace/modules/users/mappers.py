"""The contract's `User` (users.yaml#/User), the port of backend-express/src/modules/users/view.ts: signed avatar URL,
organization ref with a public logo, roles in the order of the `roles` dictionary."""

from __future__ import annotations

from typing import Any

from agrotrace.core import sql
from agrotrace.infra import file_urls

_VIEWS = """
SELECT u.id::text AS id, u.email::text AS email, u.full_name, u.phone, u.avatar_file_id::text AS avatar_file_id,
       u.is_org_admin, u.status, o.id::text AS org_id, o.name AS org_name, o.type AS org_type,
       o.logo_file_id::text AS logo_file_id,
       ARRAY(SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.id) AS roles
  FROM users u JOIN organizations o ON o.id = u.organization_id
 WHERE u.id = ANY(%s::uuid[])
"""


def load_user_views(ids: list[str]) -> list[dict[str, Any]]:
    """Views of `ids` in the order given (missing ids are skipped)."""
    if not ids:
        return []
    by_id = {r["id"]: r for r in sql.all(_VIEWS, [ids])}
    out = []
    for i in ids:
        u = by_id.get(i)
        if u is None:
            continue
        out.append({
            "id": u["id"],
            "email": u["email"].lower(),
            "fullName": u["full_name"],
            "phone": u["phone"],
            "avatarUrl": file_urls.signed(u["avatar_file_id"]) if u["avatar_file_id"] else None,
            "roles": list(u["roles"]),
            "isOrgAdmin": u["is_org_admin"],
            "status": u["status"],
            "organization": {
                "id": u["org_id"],
                "name": u["org_name"],
                "type": u["org_type"],
                "logoUrl": file_urls.public_url(u["logo_file_id"]) if u["logo_file_id"] else None,
            },
        })
    return out
