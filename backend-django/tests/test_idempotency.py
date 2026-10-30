"""
`core.idempotency` (BR-11, R48, R53) against the shared Redis of the stand (unique keys, removed afterwards):

- the fingerprint equals Express's `requestFingerprint` (value pinned from node's crypto);
- a `done` record written in Express's format is replayed with `Idempotent-Replayed: true` and its body as JSON;
- COMPLETE_LUA / RELEASE_LUA never touch a foreign or a finished record;
- an owner's 4xx/5xx frees the key, a 2xx stores the body EXACTLY as the client got it — a Decimal or a datetime in
  the response neither fails the save (Task 1 review) nor changes on replay (byte-identical);
- a key with a trailing "\\n" is INVALID_IDEMPOTENCY_KEY (JS `$` does not match before a final newline).
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from django.test import override_settings

from agrotrace.core import access, idempotency, ratelimit
from agrotrace.core import views as core_views
from agrotrace.core.idempotency import IdemStore, Replay, begin, done_record, fingerprint, raw_member
from agrotrace.core.problem import AppProblem
from agrotrace.infra import redis
from agrotrace.security.jwt import Principal
from tests import idem_urls
from tests.asgi_client import call

EXPRESS_FP = "c9a6a9ce94bd682072bcf17bf7a41db7ebc0991c894dcf0857b2665c3098bcf8"


def test_the_fingerprint_is_express_s():
    # node: sha256("POST /api/v1/waybills\n" + '{"a":1}') — backend-express requestFingerprint.
    assert fingerprint("POST", "/api/v1/waybills", b'{"a":1}') == EXPRESS_FP
    assert fingerprint("POST", "/a", b"") == fingerprint("POST", "/a", None)  # type: ignore[arg-type]


@pytest.mark.parametrize("key", ["abcdefgh\n", "abcdefgh\r", "abc", "a" * 129, "ключ-ключ-ключ", ""])
def test_a_malformed_key_is_invalid(key):
    with pytest.raises(AppProblem) as e:
        begin("u", key, "POST", "/api/v1/waybills", b"{}", store=object())  # type: ignore[arg-type]
    assert (e.value.status, e.value.code) == (400, "INVALID_IDEMPOTENCY_KEY")


@pytest.fixture
def keys():
    made: list[str] = []

    def new() -> str:
        k = f"idem:test-{uuid.uuid4()}:{uuid.uuid4().hex}"
        made.append(k)
        return k

    yield new
    if made:
        redis.client().delete(*made)


def test_an_express_done_record_is_replayed_as_stored():
    r = redis.client()
    user = f"test-{uuid.uuid4()}"
    key = uuid.uuid4().hex
    raw = b'{"receiverOrgId":"x"}'
    body_text = '{"id":"7e9a","massKg":"12.500","note":"stored elsewhere","n":1e-7,"big":12345678901234567890}'
    record = ('{"fingerprint":"' + fingerprint("POST", "/api/v1/waybills", raw)
              + '","state":"done","status":201,"body":' + body_text + "}")
    r.set(f"idem:{user}:{key}", record, ex=120)
    try:
        with pytest.raises(Replay) as e:
            begin(user, key, "POST", "/api/v1/waybills", raw)
        res = e.value.response
        assert res.status_code == 201
        assert res["Idempotent-Replayed"] == "true"
        assert res["Content-Type"] == "application/json; charset=utf-8"
        assert res.content == body_text.encode()
        assert json.loads(res.content)["note"] == "stored elsewhere"
    finally:
        r.delete(f"idem:{user}:{key}")


def test_a_record_without_a_body_replays_null(keys):
    k = keys()
    fp = fingerprint("POST", "/p", b"")
    redis.client().set(k, json.dumps({"fingerprint": fp, "state": "done", "status": 200}), ex=60)
    rec = IdemStore().get(k)
    assert rec is not None
    assert idempotency.replay_response(rec).content == b"null"


def test_complete_and_release_touch_only_the_own_pending_record(keys):
    s = IdemStore()
    r = redis.client()
    mine, other = "fp-mine", "fp-other"

    foreign = keys()
    r.set(foreign, json.dumps({"fingerprint": other, "state": "pending"}), ex=60)
    assert s.complete(foreign, mine, 201, '{"a":1}') is False
    assert s.release(foreign, mine) is False
    assert json.loads(r.get(foreign)) == {"fingerprint": other, "state": "pending"}

    finished = keys()
    done = done_record(mine, 201, '{"a":1}')
    r.set(finished, done, ex=600)
    assert s.complete(finished, mine, 200, '{"b":2}') is False
    assert s.release(finished, mine) is False
    assert r.get(finished).decode() == done

    broken = keys()
    r.set(broken, "not json", ex=60)
    assert s.complete(broken, mine, 201, "1") is False and s.release(broken, mine) is False
    assert r.get(broken) == b"not json"

    own = keys()
    assert s.claim(own, mine) is True and s.claim(own, mine) is False
    assert 0 < r.ttl(own) <= idempotency.PENDING_TTL_SEC
    assert s.complete(own, mine, 201, '{"a":1}') is True
    assert r.get(own).decode() == '{"fingerprint":"fp-mine","state":"done","status":201,"body":{"a":1}}'
    assert idempotency.PENDING_TTL_SEC < r.ttl(own) <= idempotency.DONE_TTL_SEC

    freed = keys()
    assert s.claim(freed, mine)
    assert s.release(freed, mine) is True and r.exists(freed) == 0


def test_the_owner_s_answer_settles_once(keys):
    s = IdemStore()
    k = keys()
    assert s.claim(k, "fp")
    c = idempotency.Claim(s, k, "fp")
    c.settle(422, None)
    assert redis.client().exists(k) == 0
    c.settle(201, '{"late":true}')  # settled already: nothing happens
    assert redis.client().exists(k) == 0


def test_raw_member_reads_the_exact_text():
    text = '{ "fingerprint" : "f", "body" : {"a": [1, 2.50, "x\\"y"]} , "status":201 }'
    assert raw_member(text, "body") == '{"a": [1, 2.50, "x\\"y"]}'
    assert raw_member('{"body":1,"body":[2]}', "body") == "[2]"  # the last one, as JSON.parse keeps it
    assert raw_member('{"status":1}', "body") is None
    assert raw_member("[1]", "body") is None
    assert raw_member('{"body":1} x', "body") is None


# ── over the view (ContractView.finalize_response) ────────────────────────────────────────────────────────────────

USER = Principal(user_id=f"test-{uuid.uuid4()}", org_id=str(uuid.uuid4()), roles=("FARMER",), org_admin=False)
TYPED = "/api/v1/test/idem/typed"


@pytest.fixture
def as_user(monkeypatch):
    monkeypatch.setattr(core_views, "authenticate", lambda request: USER)
    monkeypatch.setattr(ratelimit, "hit", lambda *a, **kw: None)
    monkeypatch.setattr(access, "require", lambda op, p: None)
    idem_urls.CALLS.clear()
    made: list[str] = []
    yield made
    if made:
        redis.client().delete(*made)


def _post(path: str, key: str, body: bytes = b'{"x":1}'):
    headers = {"Idempotency-Key": key, "Content-Type": "application/json"}
    return asyncio.run(call("POST", path, headers=headers, body=body))


@override_settings(ROOT_URLCONF="tests.idem_urls")
def test_a_decimal_and_a_datetime_body_is_stored_and_replayed_byte_identical(as_user):
    key = uuid.uuid4().hex
    as_user.append(f"idem:{USER.user_id}:{key}")
    first = _post(TYPED, key)
    assert first.status == 201, first.body
    assert first.json() == {"mass": "12480.500", "at": "2026-09-24T08:30:00.123Z", "name": "КФХ «Петров»",
                            "n": [1, 2.5, None, True]}
    rec = redis.client().get(f"idem:{USER.user_id}:{key}").decode()
    assert json.loads(rec)["state"] == "done"  # saved, not left pending (the Task 1 review case)
    assert rec == done_record(fingerprint("POST", TYPED, b'{"x":1}'), 201, first.body.decode())
    again = _post(TYPED, key)
    assert again.status == 201
    assert again.headers["idempotent-replayed"] == "true"
    assert again.body == first.body
    assert again.headers["content-type"] == "application/json; charset=utf-8"
    assert idem_urls.CALLS == ["typed"]  # the replay did not run the handler


@override_settings(ROOT_URLCONF="tests.idem_urls")
@pytest.mark.parametrize(("path", "status"), [("/api/v1/test/idem/fails", 409), ("/api/v1/test/idem/crashes", 500)])
def test_an_owner_s_4xx_or_5xx_frees_the_key(as_user, path, status):
    key = uuid.uuid4().hex
    as_user.append(f"idem:{USER.user_id}:{key}")
    assert _post(path, key).status == status
    assert redis.client().exists(f"idem:{USER.user_id}:{key}") == 0
    assert _post(path, key).status == status  # executes again, not IN_PROGRESS
    assert len(idem_urls.CALLS) == 2


@override_settings(ROOT_URLCONF="tests.idem_urls")
def test_another_request_with_the_key_is_reused_and_a_pending_one_in_progress(as_user):
    key = uuid.uuid4().hex
    k = f"idem:{USER.user_id}:{key}"
    as_user.append(k)
    pending = {"fingerprint": fingerprint("POST", TYPED, b'{"x":1}'), "state": "pending"}
    redis.client().set(k, json.dumps(pending), ex=60)
    busy = _post(TYPED, key)
    assert busy.status == 409
    assert busy.json()["code"] == "IDEMPOTENCY_KEY_IN_PROGRESS"
    assert busy.headers["retry-after"] == "1"
    other = _post(TYPED, key, b'{"x":2}')
    assert other.status == 409
    assert other.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert json.loads(redis.client().get(k))["state"] == "pending"  # a foreign pending record is never touched
    assert idem_urls.CALLS == []


@override_settings(ROOT_URLCONF="tests.idem_urls")
def test_a_2xx_that_fails_to_render_frees_the_key(as_user):
    # Task 7 review M1: the render runs in finalize_response; when it fails, the answer is a 500 and the key is freed
    # (Express releases on a crash rendered as 500), so a retry executes again instead of 409 IN_PROGRESS for 60 s.
    path = "/api/v1/test/idem/unrenderable"
    key = uuid.uuid4().hex
    as_user.append(f"idem:{USER.user_id}:{key}")
    first = _post(path, key)
    assert first.status == 500
    assert first.json()["code"] == "INTERNAL"
    assert redis.client().exists(f"idem:{USER.user_id}:{key}") == 0
    assert _post(path, key).status == 500  # executes again, not IN_PROGRESS
    assert idem_urls.CALLS == ["unrenderable", "unrenderable"]


def test_the_replayed_status_defaults_to_200_only_when_absent(keys):
    # Task 7 review M5: Express `stored.status ?? 200` — a missing or null status is 200; any other value is sent as
    # stored (a 0 is not turned into 200; Node refuses it, and so does Django: the request fails as a 500).
    s = IdemStore()
    fp = fingerprint("POST", "/p", b"")
    for status, expected in ((None, 200), ("absent", 200), (202, 202)):
        k = keys()
        rec = {"fingerprint": fp, "state": "done", "body": {"a": 1}}
        if status != "absent":
            rec["status"] = status
        redis.client().set(k, json.dumps(rec), ex=60)
        stored = s.get(k)
        assert stored is not None
        assert idempotency.replay_response(stored).status_code == expected
    k = keys()
    redis.client().set(k, json.dumps({"fingerprint": fp, "state": "done", "status": 0, "body": None}), ex=60)
    stored = s.get(k)
    assert stored is not None
    with pytest.raises(ValueError):
        idempotency.replay_response(stored)
