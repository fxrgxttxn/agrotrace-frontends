"""
`Idempotency-Key` (BR-11, R48, R53) for operations with `x-idempotent: true`, the port of
backend-express/src/http/idempotency.ts — records are interchangeable with Express's (same key, JSON value and Lua):

- key missing or not `^[A-Za-z0-9_-]{8,128}$` → 400 INVALID_IDEMPOTENCY_KEY;
- Redis key `idem:{userId}:{key}`; fingerprint = sha256 hex of `"{METHOD} {path}\n"` + the raw body bytes (the raw
  path without the query string);
- `SET NX EX 60` of `{"fingerprint", "state": "pending"}`; the key exists: another fingerprint → 409
  IDEMPOTENCY_KEY_REUSED; same and pending → 409 IDEMPOTENCY_KEY_IN_PROGRESS + `Retry-After: 1`; same and done → the
  stored response again (status, body as application/json, `Idempotent-Replayed: true`);
- the owner's response settles the record BEFORE it is sent (ContractView.finalize_response): 2xx → COMPLETE_LUA
  stores `{"fingerprint", "state": "done", "status", "body"}` for 86400 s; any other answer → RELEASE_LUA frees the
  key. A client disconnect settles nothing: the owner finishes and settles (T6-7 I1).
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any

from django.http import HttpResponse

from agrotrace.core.problem import AppProblem
from agrotrace.core.render import json_bytes
from agrotrace.domain.idempotency import idempotency_decision

log = logging.getLogger("agrotrace.idempotency")

PENDING_TTL_SEC = 60
DONE_TTL_SEC = 86400

OWN_PENDING = """
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, d = pcall(cjson.decode, v)
if not ok or type(d) ~= 'table' or d.fingerprint ~= ARGV[1] or d.state ~= 'pending' then return 0 end
"""
COMPLETE_LUA = f"""{OWN_PENDING}redis.call('SET', KEYS[1], ARGV[2], 'EX', {DONE_TTL_SEC})
return 1"""
RELEASE_LUA = f"""{OWN_PENDING}redis.call('DEL', KEYS[1])
return 1"""


def _js(obj: Any) -> str:
    """JSON.stringify (compact, UTF-8 as is)."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def fingerprint(method: str, path: str, raw: bytes) -> str:
    """sha256 hex of `"{METHOD} {path}\n"` followed by the raw request body bytes."""
    h = hashlib.sha256()
    h.update(f"{method} {path}\n".encode())
    h.update(raw or b"")
    return h.hexdigest()


class IdemStore:
    """The storage operations of the protocol over the shared Redis."""

    def __init__(self, client=None):
        if client is None:
            from agrotrace.infra import redis

            client = redis.client()
        self.r = client

    def claim(self, key: str, fp: str) -> bool:
        return bool(self.r.set(key, _js({"fingerprint": fp, "state": "pending"}), ex=PENDING_TTL_SEC, nx=True))

    def get(self, key: str) -> dict | None:
        v = self.r.get(key)
        if v is None:
            return None
        try:
            d = json.loads(v)
        except ValueError:
            return None
        return d if isinstance(d, dict) and isinstance(d.get("fingerprint"), str) else None

    def complete(self, key: str, fp: str, status: int, body: Any) -> bool:
        value = _js({"fingerprint": fp, "state": "done", "status": status, "body": body})
        return int(self.r.eval(COMPLETE_LUA, 1, key, fp, value)) == 1

    def release(self, key: str, fp: str) -> bool:
        return int(self.r.eval(RELEASE_LUA, 1, key, fp)) == 1


@dataclass
class Claim:
    store: IdemStore
    key: str
    fingerprint: str
    settled: bool = False

    def settle(self, status: int, body: Any) -> None:
        if self.settled:
            return
        self.settled = True
        try:
            if 200 <= status < 300:
                self.store.complete(self.key, self.fingerprint, status, body)
            else:
                self.store.release(self.key, self.fingerprint)
        except Exception as e:  # never fails the response; the pending mark expires (60 s)
            log.warning("idempotency record not settled", extra={"err": str(e)})


class Replay(Exception):
    """The stored response of a finished request with the same key (raised from ContractView.initial)."""

    def __init__(self, response: HttpResponse):
        self.response = response


def begin(user_id: str, key_header: str | None, method: str, raw_path: str, raw_body: bytes,
          store: IdemStore | None = None) -> Claim:
    """Claims the key for this request (the owner) — or raises 400/409, or Replay with the stored response."""
    k = key_header if isinstance(key_header, str) else ""
    fp = fingerprint(method, raw_path, raw_body)
    if idempotency_decision(k, None, fp) == "INVALID_KEY":
        raise AppProblem(400, "INVALID_IDEMPOTENCY_KEY")
    store = store or IdemStore()
    redis_key = f"idem:{user_id}:{k}"
    for _ in range(2):
        if store.claim(redis_key, fp):
            return Claim(store, redis_key, fp)
        stored = store.get(redis_key)
        if not stored:
            continue  # expired between SET NX and GET — claim again
        if idempotency_decision(k, stored, fp) == "CONFLICT":
            raise AppProblem(409, "IDEMPOTENCY_KEY_REUSED")
        if stored.get("state") != "done":
            raise AppProblem(409, "IDEMPOTENCY_KEY_IN_PROGRESS", headers={"Retry-After": "1"})
        res = HttpResponse(json_bytes(stored.get("body")), status=stored.get("status") or 200,
                           content_type="application/json; charset=utf-8")
        res["Idempotent-Replayed"] = "true"
        raise Replay(res)
    raise AppProblem(409, "IDEMPOTENCY_KEY_IN_PROGRESS", headers={"Retry-After": "1"})
