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

The stored `body` is the response body exactly as it was rendered to the client (its JSON text spliced into the
record, never re-serialized from Python values: a Decimal or a datetime can neither fail the save nor change form),
and a replay sends the record's `body` member text as is — byte-identical to the first answer. A record written by
another backend is replayed from its own `body` text the same way.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass

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


def _js(obj) -> str:
    """JSON.stringify (compact, UTF-8 as is) of plain JSON values."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def fingerprint(method: str, path: str, raw: bytes) -> str:
    """sha256 hex of `"{METHOD} {path}\n"` followed by the raw request body bytes."""
    h = hashlib.sha256()
    h.update(f"{method} {path}\n".encode())
    h.update(raw or b"")
    return h.hexdigest()


def done_record(fp: str, status: int, body_json: str | None) -> str:
    """The `done` record as Express writes it (`{"fingerprint","state","status","body"}`, that key order); `body_json`
    is the JSON text of the response body (None → `null`), spliced in unchanged."""
    return (f'{{"fingerprint":{_js(fp)},"state":"done","status":{int(status)},'
            f'"body":{body_json if body_json is not None else "null"}}}')


_WS = re.compile(r"[ \t\n\r]*")
_DECODER = json.JSONDecoder()


def _skip(text: str, i: int) -> int:
    return _WS.match(text, i).end()  # type: ignore[union-attr]  # the pattern matches the empty string


def raw_member(text: str, name: str) -> str | None:
    """The exact JSON text of the top-level member `name` of the object `text` (the last one, as JSON.parse keeps it);
    None when it is absent or `text` is not a JSON object."""
    try:
        i = _skip(text, 0)
        if text[i] != "{":
            return None
        i = _skip(text, i + 1)
        if text[i] == "}":
            return None
        found = None
        while True:
            key, i = _DECODER.raw_decode(text, i)
            if not isinstance(key, str):
                return None
            i = _skip(text, i)
            if text[i] != ":":
                return None
            i = _skip(text, i + 1)
            start = i
            _, i = _DECODER.raw_decode(text, i)
            if key == name:
                found = text[start:i]
            i = _skip(text, i)
            if text[i] == ",":
                i = _skip(text, i + 1)
                continue
            if text[i] == "}" and _skip(text, i + 1) == len(text):
                return found
            return None
    except (ValueError, IndexError):
        return None


class Record(dict):
    """A stored record (the parsed JSON) with its raw text (`raw`) — the replay sends the raw `body` member."""

    raw: str = ""


class IdemStore:
    """The storage operations of the protocol over the shared Redis."""

    def __init__(self, client=None):
        if client is None:
            from agrotrace.infra import redis

            client = redis.client()
        self.r = client

    def claim(self, key: str, fp: str) -> bool:
        """SET NX EX 60 of the pending mark; False — the key exists."""
        return bool(self.r.set(key, _js({"fingerprint": fp, "state": "pending"}), ex=PENDING_TTL_SEC, nx=True))

    def get(self, key: str) -> Record | None:
        v = self.r.get(key)
        if v is None:
            return None
        try:
            text = v.decode("utf-8") if isinstance(v, bytes) else str(v)
            d = json.loads(text)
        except (ValueError, UnicodeDecodeError):
            return None
        if not isinstance(d, dict) or not isinstance(d.get("fingerprint"), str):
            return None
        rec = Record(d)
        rec.raw = text
        return rec

    def complete(self, key: str, fp: str, status: int, body_json: str | None) -> bool:
        """Compare-and-set to `done` (only the own pending record); `body_json` — the response body's JSON text."""
        return int(self.r.eval(COMPLETE_LUA, 1, key, fp, done_record(fp, status, body_json))) == 1

    def release(self, key: str, fp: str) -> bool:
        """Compare-and-delete (only the own pending record)."""
        return int(self.r.eval(RELEASE_LUA, 1, key, fp)) == 1


@dataclass
class Claim:
    store: IdemStore
    key: str
    fingerprint: str
    settled: bool = False

    def settle(self, status: int, body_json: str | None) -> None:
        """2xx → the record is `done` with this body text; anything else frees the key. Once per request."""
        if self.settled:
            return
        self.settled = True
        try:
            if 200 <= status < 300:
                self.store.complete(self.key, self.fingerprint, status, body_json)
            else:
                self.store.release(self.key, self.fingerprint)
        except Exception as e:  # never fails the response; the pending mark expires (60 s)
            log.warning("idempotency record not settled", extra={"err": str(e)})


def response_body_json(content: bytes) -> str | None:
    """The body of a 2xx answer as the record's `body`: its exact text when it is JSON, else None (Express: a body
    JSON.parse refuses is stored as null)."""
    if not content:
        return None
    from agrotrace.core.body import js_json_parse

    try:
        text = content.decode("utf-8")
        js_json_parse(text)
    except (ValueError, UnicodeDecodeError):
        return None
    return text


class Replay(Exception):
    """The stored response of a finished request with the same key (raised from ContractView.initial)."""

    def __init__(self, response: HttpResponse):
        self.response = response


def replay_response(stored: Record) -> HttpResponse:
    """The stored answer: its status and the record's `body` text unchanged (`null` when absent)."""
    body = raw_member(stored.raw, "body") if stored.raw else None
    content = body.encode("utf-8") if body is not None else json_bytes(stored.get("body"))
    status = stored.get("status")
    status = 200 if status is None else status  # Express `stored.status ?? 200` (Task 7 review M5)
    res = HttpResponse(content, status=status, content_type="application/json; charset=utf-8")
    res["Idempotent-Replayed"] = "true"
    return res


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
        raise Replay(replay_response(stored))
    raise AppProblem(409, "IDEMPOTENCY_KEY_IN_PROGRESS", headers={"Retry-After": "1"})
