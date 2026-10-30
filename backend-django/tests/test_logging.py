"""
JSON log lines (core.logging, port of backend-express/src/logger.ts): every line is one JSON object with
`backend: "django"`, the request's `requestId` (X-Request-Id) during a request and the envelope's `requestId` inside an
event handler; secrets are `***` at any depth (P8) — whether passed as stdlib `extra` or structlog keywords.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import uuid
from contextlib import contextmanager

import pytest
import structlog

from agrotrace.core import logging as at_logging
from agrotrace.events import tasks
from tests.asgi_client import call


@pytest.fixture
def lines():
    """The JSON lines the process formatter writes while the test runs."""
    root = logging.getLogger()
    formatter = next(h.formatter for h in root.handlers
                     if isinstance(h.formatter, structlog.stdlib.ProcessorFormatter))
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(formatter)
    root.addHandler(handler)
    try:
        yield lambda: [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
    finally:
        root.removeHandler(handler)


def test_a_request_line_is_json_with_backend_and_the_request_id(lines):
    rid = "log-test-" + uuid.uuid4().hex[:12]
    r = asyncio.run(call("GET", "/api/v1/no/such/path/for-logging", headers={"X-Request-Id": rid}))
    assert r.status == 404 and r.headers["x-request-id"] == rid
    access = [ln for ln in lines() if ln.get("msg") == "request" and ln.get("path") == "/api/v1/no/such/path/for-logging"]
    assert len(access) == 1, lines()
    line = access[0]
    assert line["backend"] == "django"
    assert line["requestId"] == rid
    assert line["status"] == 404 and line["method"] == "GET"
    assert {"time", "level", "process"} <= line.keys()


@contextmanager
def _delivered(task, envelope):
    task.push_request(id=envelope["id"], task=task.name, args=[envelope], kwargs={}, retries=0, root_id=envelope["id"],
                      parent_id=None, group=None, origin="gen1@worker")
    try:
        yield
    finally:
        task.pop_request()


def test_an_event_handler_line_carries_the_envelope_request_id(lines):
    handler_log = logging.getLogger("agrotrace.test.handler")

    def handler(envelope):
        handler_log.info("handled in test", extra={"eventId": envelope["id"]})

    task = tasks.event_task("test.logging-handler")(handler)
    env = {"id": str(uuid.uuid4()), "type": "test.logging-handler", "occurredAt": "2026-10-22T00:00:00.000Z",
           "backend": "django", "requestId": "env-req-42", "data": {}}
    with _delivered(task, env):
        task._handle(env)
    got = [ln for ln in lines() if ln.get("msg") == "handled in test"]
    assert len(got) == 1, lines()
    assert got[0]["requestId"] == "env-req-42"
    assert got[0]["backend"] == "django" and got[0]["eventId"] == env["id"]


SECRETS = {"password": "pw-123", "token": "tok-123", "refresh": "ref-123", "secret": "sec-123", "totp": "123456"}


def _nested() -> dict:
    return {
        **SECRETS,
        "user": {"email": "a@b.c", "Password": "pw-123", "deep": [{"token": "tok-123"}, {"x": {"totp": "123456"}}]},
        "list": [{"refresh": "ref-123"}, ({"secret": "sec-123"},)],
    }


def _assert_masked(line: dict) -> None:
    text = json.dumps(line)
    for value in SECRETS.values():
        assert value not in text, text
    assert line["password"] == line["token"] == line["refresh"] == line["secret"] == line["totp"] == "***"
    assert line["user"]["email"] == "a@b.c" and line["user"]["Password"] == "***"
    assert line["user"]["deep"][0]["token"] == "***" and line["user"]["deep"][1]["x"]["totp"] == "***"
    assert line["list"][0]["refresh"] == "***" and line["list"][1][0]["secret"] == "***"


def test_secrets_are_masked_at_any_depth_stdlib_extra(lines):
    logging.getLogger("agrotrace.test.mask").warning("stdlib secrets", extra=_nested())
    got = [ln for ln in lines() if ln.get("msg") == "stdlib secrets"]
    assert len(got) == 1
    _assert_masked(got[0])


def test_secrets_are_masked_at_any_depth_structlog_keywords(lines):
    at_logging.get("agrotrace.test.mask").warning("structlog secrets", **_nested())
    got = [ln for ln in lines() if ln.get("msg") == "structlog secrets"]
    assert len(got) == 1
    _assert_masked(got[0])


# ── P8 / final review I1: no log line carries the SSE access_token or a signed link's sig/exp ─────────────────────────


def _bearer_token() -> str:
    from datetime import UTC, datetime

    from agrotrace.security.jwt import Principal, issue_access_token

    p = Principal(user_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), roles=("FARMER",), org_admin=False)
    return issue_access_token(p, datetime.now(UTC))


def _rate_limited(*_args, **_kwargs):
    from agrotrace.core.problem import AppProblem

    raise AppProblem(429, "RATE_LIMITED", params={"scope": "user", "limit": 1, "windowSec": 60},
                     headers={"Retry-After": "1"})


def _assert_one_access_line_without(lines, path: str, status: int, secrets: list[str]) -> None:
    got = lines()
    for ln in got:
        text = json.dumps(ln, ensure_ascii=False)
        for secret in secrets:
            assert secret not in text, text
    access = [ln for ln in got if ln.get("msg") == "request" and ln.get("path") == path]
    assert len(access) == 1 and access[0]["status"] == status, got
    # One line per outcome: Django's own "Unauthorized: …" / "Not Found: …" (django.request) is silenced.
    assert not [ln for ln in got if ln.get("msg") != "request" and path in json.dumps(ln)], got


def test_sse_401_logs_no_access_token(lines):
    secret = "SECRETTOKEN" + uuid.uuid4().hex
    r = asyncio.run(call("GET", f"/api/v1/events/stream?access_token={secret}"))
    assert r.status == 401
    _assert_one_access_line_without(lines, "/api/v1/events/stream", 401, [secret])


def test_sse_429_logs_no_access_token(lines, monkeypatch):
    from agrotrace.core import ratelimit

    monkeypatch.setattr(ratelimit, "hit", _rate_limited)
    token = _bearer_token()
    r = asyncio.run(call("GET", f"/api/v1/events/stream?access_token={token}&lastEventId=7"))
    assert r.status == 429
    _assert_one_access_line_without(lines, "/api/v1/events/stream", 429, [token])


def _signed_link(file_id: str) -> tuple[str, str, str]:
    from urllib.parse import parse_qs, urlsplit

    from agrotrace.infra import file_urls

    link = file_urls.signed(file_id)
    q = parse_qs(urlsplit(link).query)
    return link, q["exp"][0], q["sig"][0]


def test_signed_link_404_logs_no_signature(lines, monkeypatch):
    from agrotrace.modules.files import services

    monkeypatch.setattr(services, "live_file", lambda _id: None)
    file_id = str(uuid.uuid4())
    link, exp, sig = _signed_link(file_id)
    r = asyncio.run(call("GET", link))
    assert r.status == 404
    _assert_one_access_line_without(lines, f"/api/v1/files/{file_id}", 404, [sig, f"exp={exp}", exp])


def test_signed_link_429_logs_no_signature(lines, monkeypatch):
    from agrotrace.core import ratelimit

    monkeypatch.setattr(ratelimit, "hit", _rate_limited)
    token = _bearer_token()
    file_id = str(uuid.uuid4())
    link, exp, sig = _signed_link(file_id)
    r = asyncio.run(call("GET", link, headers={"Authorization": f"Bearer {token}"}))
    assert r.status == 429
    _assert_one_access_line_without(lines, f"/api/v1/files/{file_id}", 429, [sig, exp, token])


def test_a_record_attribute_that_is_not_json_data_is_never_written(lines):
    class Leaky:
        def __repr__(self):
            return "<Leaky ?access_token=LEAKED-SECRET>"

        __str__ = __repr__

    logging.getLogger("agrotrace.test.leak").warning("leaky extra", extra={"request": Leaky(), "status_code": 401,
                                                                            "nested": {"ok": [1, "a", None]}})
    got = [ln for ln in lines() if ln.get("msg") == "leaky extra"]
    assert len(got) == 1
    assert "LEAKED-SECRET" not in json.dumps(got[0]) and "request" not in got[0]
    assert got[0]["status_code"] == 401 and got[0]["nested"] == {"ok": [1, "a", None]}


def test_value_types_in_extras_are_written_as_text(lines):
    """Rereview m3: an id, an instant or an amount is the value itself — written, not silently dropped."""
    import datetime as dt
    import decimal
    import uuid as uuid_mod

    bid = uuid_mod.UUID("0f0e0d0c-0b0a-4908-8706-050403020100")
    logging.getLogger("agrotrace.test.types").warning("typed extras", extra={
        "batchId": bid, "at": dt.datetime(2026, 10, 30, 9, 0, tzinfo=dt.UTC), "mass": decimal.Decimal("1.500")})
    got = [ln for ln in lines() if ln.get("msg") == "typed extras"]
    assert len(got) == 1
    assert got[0]["batchId"] == str(bid) and got[0]["mass"] == "1.500" and got[0]["at"].startswith("2026-10-30")


def test_an_error_django_turns_into_a_500_is_logged_once_with_its_traceback_and_no_token(lines, monkeypatch):
    """Re-review R1: a plain (non-DRF) view that raises — here the SSE view with no hub — reaches handler500, which
    logs it like render_exception (path only, exc_info); django.request stays silent."""
    from agrotrace.core import ratelimit
    from agrotrace.sse import hub as sse_hub

    monkeypatch.setattr(ratelimit, "hit", lambda *a, **k: None)
    monkeypatch.setattr(sse_hub, "hub", lambda: None)
    token = _bearer_token()
    r = asyncio.run(call("GET", f"/api/v1/events/stream?access_token={token}"))
    assert r.status == 500
    got = lines()
    for ln in got:
        assert token not in json.dumps(ln, ensure_ascii=False), ln
    errors = [ln for ln in got if ln.get("msg") == "unhandled error"]
    assert len(errors) == 1, got
    assert errors[0]["path"] == "/api/v1/events/stream" and errors[0]["level"] == "error"
    assert "no SSE hub" in errors[0]["exception"]
    access = [ln for ln in got if ln.get("msg") == "request" and ln.get("path") == "/api/v1/events/stream"]
    assert len(access) == 1 and access[0]["status"] == 500
