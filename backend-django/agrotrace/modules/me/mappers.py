"""
The contract's `Me` (users.yaml#/Me), the port of backend-express/src/modules/me/view.ts: the signed-in user as
login/verify/refresh and getMe return it. Avatar — a signed URL (R28), organization logo — a public URL; roles in the
stable order of the `roles` dictionary (by id). Read on every call (stand writes are never cached, P48/P59).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import sql
from agrotrace.infra import file_urls

_ME = """
SELECT u.id::text AS id, u.email::text AS email, u.full_name, u.phone, u.avatar_file_id::text AS avatar_file_id,
       u.is_org_admin, u.totp_enabled, u.notification_channels, u.telegram_chat_id,
       o.id::text AS org_id, o.name AS org_name, o.type AS org_type, o.logo_file_id::text AS logo_file_id,
       ARRAY(SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.id) AS roles
  FROM users u JOIN organizations o ON o.id = u.organization_id
 WHERE u.id = %s AND u.deleted_at IS NULL
"""


def channels_of(stored: Any, telegram_chat_id: Any) -> dict[str, bool]:
    stored = sql.jsonb(stored)
    ch = stored if isinstance(stored, dict) else {}
    return {"email": ch.get("email") is True, "telegram": ch.get("telegram") is True,
            "telegramLinked": telegram_chat_id is not None}


def load_me(user_id: str) -> dict[str, Any] | None:
    u = sql.one(_ME, [user_id])
    if u is None:
        return None
    return {
        "id": u["id"],
        "email": u["email"].lower(),
        "fullName": u["full_name"],
        "phone": u["phone"],
        "avatarUrl": file_urls.signed(u["avatar_file_id"]) if u["avatar_file_id"] else None,
        "roles": list(u["roles"]),
        "organization": {
            "id": u["org_id"],
            "name": u["org_name"],
            "type": u["org_type"],
            "logoUrl": file_urls.public_url(u["logo_file_id"]) if u["logo_file_id"] else None,
        },
        "isOrgAdmin": u["is_org_admin"],
        "totpEnabled": u["totp_enabled"],
        "channels": channels_of(u["notification_channels"], u["telegram_chat_id"]),
    }
