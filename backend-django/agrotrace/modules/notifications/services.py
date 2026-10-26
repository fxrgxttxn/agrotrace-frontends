"""
Notification center (contracts/openapi/paths/notifications.yaml, FR-NOTIF-01…04), the port of
backend-express/src/modules/notifications/service.ts: the user's own IN_APP rows (EMAIL/TELEGRAM rows are delivery
records, never listed) and marking them read.

markNotificationsRead: `ids` (each the user's own IN_APP row, else 400 `ids[i]: validation.notFound` and nothing is
marked) or `upToSeq`; in the same transaction `SELECT pg_notify('notifications', json_build_object('user_id', :userId,
'unread', true)::text)` — delivered to every LISTEN session at commit, so the SSE streams of the user on any
implementation get a fresh `unread`. It is the only explicit NOTIFY of the code (IN_APP inserts are announced by the
table trigger, D-M1). Marking has no audit row: the audit entity types (audit_log CHECK) have no notification
(decision 10 of Express Tasks 12-13).
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from agrotrace.core import config, sql
from agrotrace.core.params import QueryReader, utc_day_bounds
from agrotrace.core.problem import validation_problem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.modules.notifications.serializers import parse_mark_read
from agrotrace.security.jwt import Principal

SORT_FIELDS = ("seq",)
SORT_DEFAULT = "seq,desc"
COLUMNS = "id::text AS id, seq, type, payload, is_read, created_at"


@cache
def types() -> tuple[str, ...]:
    rules = json.loads((config.ROOT / "contracts" / "rules" / "notifications.json").read_text("utf-8"))
    return tuple(rules["types"])


def notification_view(r: dict[str, Any]) -> dict[str, Any]:
    """Contract `Notification`."""
    return {"id": r["id"], "seq": int(r["seq"]), "type": r["type"], "payload": sql.jsonb(r["payload"]) or {},
            "isRead": r["is_read"], "createdAt": iso(r["created_at"])}


def unread_count(user_id: str) -> int:
    return int(sql.scalar("SELECT count(*) FROM notifications WHERE user_id = %s AND channel = 'IN_APP' "
                          "AND is_read = false", [user_id]))


def list_notifications(p: Principal, request) -> dict[str, Any]:
    q = QueryReader(request)
    page, size, sort = q.page(SORT_FIELDS, SORT_DEFAULT)
    is_read = q.bool("isRead")
    kinds = q.enum_list("type", types())
    frm, to = q.date_range()
    q.done()
    conds = ["user_id = %s", "channel = 'IN_APP'"]
    params: list[Any] = [p.user_id]
    if is_read is not None:
        conds.append("is_read = %s")
        params.append(is_read)
    if kinds:
        conds.append("type = ANY(%s)")
        params.append(kinds)
    day_conds, day_params = utc_day_bounds("created_at", frm, to)
    conds += day_conds
    params += day_params
    where = " AND ".join(conds)
    total = sql.scalar(f"SELECT count(*) FROM notifications WHERE {where}", params)
    d = "ASC" if sort.dir == "asc" else "DESC"
    rows = sql.all(f'SELECT {COLUMNS} FROM notifications WHERE {where} ORDER BY seq {d}, id::text COLLATE "C" '
                   "LIMIT %s OFFSET %s", [*params, size, (page - 1) * size])
    return {"items": [notification_view(r) for r in rows], "page": page, "size": size, "total": int(total)}


def mark_read(p: Principal, raw: Any) -> dict[str, int]:
    body = parse_mark_read(raw)

    def run(tx: Tx) -> dict[str, int]:
        if "ids" in body:
            ids = [i.lower() for i in body["ids"]]
            own = {r["id"] for r in tx.all(
                "SELECT id::text AS id FROM notifications WHERE id = ANY(%s::uuid[]) AND user_id = %s "
                "AND channel = 'IN_APP'", [ids, p.user_id])}
            errors = {f"ids[{i}]": ["validation.notFound"] for i, x in enumerate(ids) if x not in own}
            if errors:
                raise validation_problem(errors)
            tx.execute("UPDATE notifications SET is_read = true WHERE user_id = %s AND channel = 'IN_APP' "
                       "AND is_read = false AND id = ANY(%s::uuid[])", [p.user_id, ids])
        else:
            tx.execute("UPDATE notifications SET is_read = true WHERE user_id = %s AND channel = 'IN_APP' "
                       "AND is_read = false AND seq <= %s", [p.user_id, body["upToSeq"]])
        tx.execute("SELECT pg_notify('notifications', json_build_object('user_id', %s::uuid, 'unread', true)::text)",
                   [p.user_id])
        return {"count": int(tx.scalar("SELECT count(*) FROM notifications WHERE user_id = %s "
                                       "AND channel = 'IN_APP' AND is_read = false", [p.user_id]))}

    return with_tx(run)
