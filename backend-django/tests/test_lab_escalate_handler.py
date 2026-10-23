"""The `lab.escalate` handler on agrotrace_test_django (R56; contracts/events/lab.escalate.schema.json,
contracts/rules/notifications.json): LAB_OVERDUE for the laboratory's heads and every inspector — one IN_APP row each
(DELIVERED) and the external rows their channels ask for (PENDING; LAB_OVERDUE is not a forced type) — with the
event's data plus the laboratory's name; inactive or deleted users get nothing; a redelivery finds its claim and
writes nothing."""

from __future__ import annotations

import json
import uuid

import pytest

from agrotrace.core import sql
from agrotrace.events.handlers import lab_escalate


def _org(type_: str, name: str) -> str:
    return sql.scalar(
        "INSERT INTO organizations (type, name, inn, region_id, status, trust_rating) "
        "VALUES (%s, %s, %s, (SELECT id FROM regions ORDER BY code LIMIT 1), 'ACTIVE', %s) RETURNING id::text",
        [type_, name, str(uuid.uuid4().int)[:12], 80 if type_ == "FARM" else None])


def _user(org: str, *, head=False, status="ACTIVE", channels=None, telegram=None, role=None, deleted=False) -> str:
    uid = sql.scalar(
        "INSERT INTO users (organization_id, email, password_hash, full_name, is_org_admin, status, "
        "notification_channels, telegram_chat_id, deleted_at) VALUES (%s, %s, 'x', 'T', %s, %s, %s::jsonb, %s, "
        "CASE WHEN %s THEN now() END) RETURNING id::text",
        [org, f"t-{uuid.uuid4().hex[:10]}@agrotrace.test", head, status,
         json.dumps(channels or {"email": True, "telegram": False}), telegram, deleted])
    if role:
        sql.execute("INSERT INTO user_roles (user_id, role_id) SELECT %s, id FROM roles WHERE code = %s", [uid, role])
    return uid


@pytest.fixture
def world(db):
    lab = _org("LAB", "ИЛ «Тест»")
    authority = _org("AUTHORITY", "Инспекция")
    users = {
        "head": _user(lab, head=True, channels={"email": True, "telegram": True}, telegram=123456, role="LAB"),
        "member": _user(lab, role="LAB"),  # not a head: nothing
        "blocked_head": _user(lab, head=True, status="BLOCKED", role="LAB"),
        "deleted_head": _user(lab, head=True, deleted=True, role="LAB"),
        "inspector": _user(authority, channels={"email": False, "telegram": False}, role="INSPECTOR"),
    }
    event_id = str(uuid.uuid4())
    yield {"lab": lab, "users": users, "event_id": event_id}
    ids = list(users.values())
    sql.execute("DELETE FROM notifications WHERE user_id = ANY(%s::uuid[])", [ids])
    sql.execute("DELETE FROM user_roles WHERE user_id = ANY(%s::uuid[])", [ids])
    sql.execute("DELETE FROM users WHERE id = ANY(%s::uuid[])", [ids])
    sql.execute("DELETE FROM organizations WHERE id = ANY(%s::uuid[])", [[lab, authority]])
    sql.execute("DELETE FROM processed_events WHERE event_id = %s", [event_id])


def _envelope(w):
    return {"id": w["event_id"], "type": "lab.escalate", "occurredAt": "2026-10-23T10:00:00.000Z",
            "backend": "django", "requestId": None,
            "data": {"labTestId": str(uuid.uuid4()), "labOrgId": w["lab"], "batchId": str(uuid.uuid4()),
                     "publicCode": "AT-2026-000123", "dueAt": "2026-10-20T10:00:00.000Z",
                     "escalatedAt": "2026-10-23T09:59:59.000Z"}}


def test_lab_overdue_for_the_heads_and_the_inspectors_once(world):
    env = _envelope(world)
    pending = lab_escalate.handle(env)
    u = world["users"]
    rows = sql.all("SELECT user_id::text AS user_id, type, channel, delivery_status, payload FROM notifications "
                   "WHERE user_id = ANY(%s::uuid[]) ORDER BY user_id, channel", [list(u.values())])
    got = sorted((r["user_id"], r["channel"], r["delivery_status"]) for r in rows)
    assert got == sorted([
        (u["head"], "IN_APP", "DELIVERED"), (u["head"], "EMAIL", "PENDING"), (u["head"], "TELEGRAM", "PENDING"),
        (u["inspector"], "IN_APP", "DELIVERED"),
    ])
    assert {r["type"] for r in rows} == {"LAB_OVERDUE"}
    assert sql.jsonb(rows[0]["payload"]) == {
        "labTestId": env["data"]["labTestId"], "batchId": env["data"]["batchId"], "publicCode": "AT-2026-000123",
        "labOrgId": world["lab"], "labName": "ИЛ «Тест»", "dueAt": "2026-10-20T10:00:00.000Z"}
    mine = {r["id"] for r in sql.all("SELECT id::text AS id FROM notifications WHERE user_id = %s "
                                     "AND delivery_status = 'PENDING'", [u["head"]])}
    assert mine <= set(pending) and len(mine) == 2
    # Redelivered: the claim is there, nothing more is written.
    assert lab_escalate.handle(env) == []
    assert sql.scalar("SELECT count(*) FROM notifications WHERE user_id = ANY(%s::uuid[])",
                      [list(u.values())]) == len(rows)
    assert sql.scalar("SELECT backend FROM processed_events WHERE event_id = %s", [world["event_id"]]) == "django"
