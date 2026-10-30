"""
Profile operations (contracts/openapi/paths/me.yaml), the port of backend-express/src/modules/me/service.ts:
FR-IAM-07 (name, phone, avatar), FR-NOTIF-02/03 (channels, Telegram link code). Transactions touch only the database;
MinIO objects are written before the row that points at them, Redis after (P8).
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime
from typing import Any

from agrotrace.core import audit, config
from agrotrace.core.multipart import Upload
from agrotrace.core.problem import AppProblem, validation_problem
from agrotrace.core.render import iso
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra.images import RASTER_TYPES
from agrotrace.infra.redis import client as redis
from agrotrace.modules.files import services as files
from agrotrace.modules.me.mappers import channels_of, load_me
from agrotrace.security.jwt import Principal

AVATAR_MAX_BYTES = 2 * 1024 * 1024
TGCODE_TTL_SEC = 600
TGCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

#: R82/R90: `tgcode:{code}` = {"userId"} (NX — never shared) and `tgcode-user:{userId}` = code, both 600 s; the
#: previous code of the user is deleted in the same script (at most one live code per user). 0 = the code collides.
TGCODE_SCRIPT = """
local previous = redis.call('GET', KEYS[2])
if not redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3], 'NX') then return 0 end
if previous and previous ~= ARGV[2] then redis.call('DEL', 'tgcode:' .. previous) end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1"""


def me(user_id: str) -> dict[str, Any]:
    view = load_me(user_id)
    if view is None:
        # A deleted account's token lives out its 15 minutes: it no longer identifies a user.
        raise AppProblem(401, "UNAUTHORIZED")
    return view


def _lock_me(tx: Tx, user_id: str, columns: str) -> dict[str, Any]:
    u = tx.one(f"SELECT {columns} FROM users WHERE id = %s AND deleted_at IS NULL FOR NO KEY UPDATE", [user_id])
    if u is None:
        raise AppProblem(401, "UNAUTHORIZED")
    return u


def update_me(p: Principal, body: dict[str, Any]) -> dict[str, Any]:
    """fullName and phone only (never trimmed, R36); `phone: null` removes the phone."""

    def run(tx: Tx) -> None:
        u = _lock_me(tx, p.user_id, "full_name, phone")
        before = {"fullName": u["full_name"], "phone": u["phone"]}
        after = {"fullName": body.get("fullName", u["full_name"]),
                 "phone": body["phone"] if "phone" in body else u["phone"]}
        diff = audit.audit_diff(before, after)
        if not diff:
            return
        tx.execute("UPDATE users SET full_name = %s, phone = %s, updated_at = now() WHERE id = %s",
                   [after["fullName"], after["phone"], p.user_id])
        audit.record(tx, action="updateMe", entity_type="user", entity_id=p.user_id, actor=p, diff=diff)

    with_tx(run)
    return me(p.user_id)


def upload_avatar(p: Principal, upload: Upload) -> dict[str, Any]:
    """JPEG/PNG/WebP ≤ 2 MiB → WebP 96/480; the previous avatar file is soft-deleted."""
    f = files.prepare(upload, kind="AVATAR", owner_id=p.user_id, allowed=RASTER_TYPES)
    files.store_objects(f)

    def run(tx: Tx) -> None:
        u = _lock_me(tx, p.user_id, "avatar_file_id::text AS avatar_file_id")
        now = tx.now
        files.insert(tx, f)
        tx.execute("UPDATE users SET avatar_file_id = %s, updated_at = %s WHERE id = %s", [f.id, now, p.user_id])
        audit.record(tx, action="uploadMyAvatar", entity_type="file", entity_id=f.id, actor=p,
                     diff=audit.audit_diff(None, files.audit_view(f)))
        audit.record(tx, action="uploadMyAvatar", entity_type="user", entity_id=p.user_id, actor=p,
                     diff={"avatarFileId": [u["avatar_file_id"], f.id]})
        if files.soft_delete(tx, u["avatar_file_id"], now):
            audit.record(tx, action="uploadMyAvatar", entity_type="file", entity_id=u["avatar_file_id"], actor=p,
                         diff={"deletedAt": [None, iso(now)]})

    with_tx(run)
    return files.file_ref(f)


def delete_avatar(p: Principal) -> None:
    """Idempotent: 204 whether or not there was an avatar."""

    def run(tx: Tx) -> None:
        u = tx.one("SELECT avatar_file_id::text AS avatar_file_id FROM users WHERE id = %s AND deleted_at IS NULL "
                   "FOR NO KEY UPDATE", [p.user_id])
        if u is None or u["avatar_file_id"] is None:
            return
        now = tx.now
        tx.execute("UPDATE users SET avatar_file_id = NULL, updated_at = %s WHERE id = %s", [now, p.user_id])
        files.soft_delete(tx, u["avatar_file_id"], now)
        audit.record(tx, action="deleteMyAvatar", entity_type="user", entity_id=p.user_id, actor=p,
                     diff={"avatarFileId": [u["avatar_file_id"], None]})
        audit.record(tx, action="deleteMyAvatar", entity_type="file", entity_id=u["avatar_file_id"], actor=p,
                     diff={"deletedAt": [None, iso(now)]})

    with_tx(run)


def channels(p: Principal) -> dict[str, bool]:
    return me(p.user_id)["channels"]


def update_channels(p: Principal, body: dict[str, Any]) -> dict[str, bool]:
    """`telegram: true` needs a linked Telegram (400 validation.telegram.notLinked)."""

    def run(tx: Tx) -> None:
        u = _lock_me(tx, p.user_id, "notification_channels, telegram_chat_id")
        if body["telegram"] and u["telegram_chat_id"] is None:
            raise validation_problem({"telegram": ["validation.telegram.notLinked"]})
        stored = channels_of(u["notification_channels"], u["telegram_chat_id"])
        before = {"email": stored["email"], "telegram": stored["telegram"]}
        after = {"email": body["email"], "telegram": body["telegram"]}
        if before == after:
            return
        tx.execute("UPDATE users SET notification_channels = %s::jsonb, updated_at = now() WHERE id = %s",
                   [json.dumps(after, separators=(",", ":")), p.user_id])
        audit.record(tx, action="updateMyChannels", entity_type="user", entity_id=p.user_id, actor=p,
                     diff={"channels": [before, after]})

    with_tx(run)
    return channels(p)


def create_telegram_code(p: Principal) -> dict[str, Any]:
    """8 characters [A-Z0-9], 10 minutes; a new code cancels the previous one (R82/R90). No bot token → 503."""
    c = config.get()
    if not c.TELEGRAM_BOT_TOKEN:
        raise AppProblem(503, "EXTERNAL_UNAVAILABLE", params={"service": "telegram"})
    me(p.user_id)
    script = redis().register_script(TGCODE_SCRIPT)
    for _ in range(5):
        code = "".join(secrets.choice(TGCODE_ALPHABET) for _ in range(8))
        issued = int(time.time())
        ok = script(keys=[f"tgcode:{code}", f"tgcode-user:{p.user_id}"],
                    args=[json.dumps({"userId": p.user_id}, separators=(",", ":")), code, str(TGCODE_TTL_SEC)])
        if int(ok) == 1:
            expires = datetime.fromtimestamp(issued + TGCODE_TTL_SEC, UTC)
            return {"code": code, "expiresAt": iso(expires).replace(".000Z", "Z"),
                    "botUsername": c.TELEGRAM_BOT_USERNAME}
    raise RuntimeError("create_telegram_code: could not draw a free code")
