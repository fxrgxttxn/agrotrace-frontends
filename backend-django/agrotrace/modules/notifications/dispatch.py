"""
The storage half of the `notification.dispatch` algorithm (contracts/events/notification.dispatch.schema.json,
contracts/rules/notifications.json), the port of backend-express/src/modules/notifications/dispatch.ts, shared by every
handler that creates notifications inside its own transaction (lab.escalate here; recall.requested — Task 10;
notification.dispatch — Task 12).

Recipients: `userIds` as is, all users of `orgIds`, the heads (`is_org_admin`) of `orgHeadIds`, every user having a
role of `roles`; only ACTIVE, non-deleted users; the union deduplicated by user id (ordered by id). Per user: one
IN_APP row (DELIVERED — the table trigger `t_notifications_notify` emits pg_notify for SSE; nothing here notifies,
or every hub would get a duplicate with another payload, D-M1) and per external channel one PENDING row — EMAIL when
`channels.email` is true or the type is forced (RECALL, RECALL_TASK, OVERDUE), TELEGRAM when Telegram is linked and
(`channels.telegram` is true or the type is forced). Every row carries `payload`.

Sending the PENDING rows (3 attempts, NOT_CONFIGURED) is the delivery half — Task 12; until then they stay PENDING.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from agrotrace.core import config
from agrotrace.core.render import json_dumps
from agrotrace.core.tx import Tx


@cache
def _rules() -> dict[str, Any]:
    return json.loads((config.ROOT / "contracts" / "rules" / "notifications.json").read_text("utf-8"))


def insert_notifications(tx: Tx, *, notification_type: str, recipients: dict[str, Any],
                         payload: dict[str, Any]) -> list[str]:
    """Resolves the recipients and inserts the rows; the ids of the PENDING (EMAIL/TELEGRAM) rows to deliver."""
    if notification_type not in _rules()["types"]:
        raise ValueError(f"unknown notification type {notification_type}")
    users = tx.all(
        "SELECT u.id::text AS id, "
        "coalesce((u.notification_channels->>'email')::boolean, false) AS email, "
        "coalesce((u.notification_channels->>'telegram')::boolean, false) AS telegram, "
        "u.telegram_chat_id IS NOT NULL AS linked "
        "FROM users u WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL "
        "AND (u.id = ANY(%s::uuid[]) OR u.organization_id = ANY(%s::uuid[]) "
        "OR (u.is_org_admin AND u.organization_id = ANY(%s::uuid[])) "
        "OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id "
        "WHERE ur.user_id = u.id AND ro.code = ANY(%s::text[]))) ORDER BY u.id",
        [list(recipients.get("userIds") or []), list(recipients.get("orgIds") or []),
         list(recipients.get("orgHeadIds") or []), list(recipients.get("roles") or [])])
    if not users:
        return []
    forced = notification_type in _rules()["forcedChannels"]
    body = json_dumps(payload)
    rows: list[tuple[str, str, str]] = []  # (user, channel, delivery status)
    for u in users:
        rows.append((u["id"], "IN_APP", "DELIVERED"))
        if u["email"] or forced:
            rows.append((u["id"], "EMAIL", "PENDING"))
        if u["linked"] and (u["telegram"] or forced):
            rows.append((u["id"], "TELEGRAM", "PENDING"))
    inserted = tx.all(
        "INSERT INTO notifications (user_id, type, payload, channel, delivery_status) "
        "SELECT x.u, %s, %s::jsonb, x.c, x.s FROM unnest(%s::uuid[], %s::text[], %s::text[]) "
        "WITH ORDINALITY AS x(u, c, s, n) ORDER BY x.n RETURNING id::text AS id, delivery_status",
        [notification_type, body, [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows]])
    return [r["id"] for r in inserted if r["delivery_status"] == "PENDING"]
