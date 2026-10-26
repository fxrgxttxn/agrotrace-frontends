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
