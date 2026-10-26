"""The request pipeline (core.middleware) over the real ASGI application: R79 request ids, X-Backend everywhere, the
contract's 405 + Allow, strict routing, and the client IP of the last X-Forwarded-For hop (P9)."""

import asyncio
from types import SimpleNamespace

import pytest

from agrotrace.core.middleware import client_ip
from tests.asgi_client import call


def get(path, method="GET", headers=None):
    return asyncio.run(call(method, path, headers=headers))


def test_live_headers():
    r = get("/api/v1/health/live", headers={"x-request-id": "A.b_c-9"})
    assert r.status == 200 and r.json() == {"status": "ok"}
    assert r.headers["content-type"] == "application/json; charset=utf-8"
    assert r.headers["x-request-id"] == "A.b_c-9" and r.headers["x-backend"] == "django"
    assert r.headers["content-length"] == str(len(r.body))
    assert "allow" not in r.headers and "server" not in r.headers


@pytest.mark.parametrize("rid", ["x" * 65, "has space", "slash/id", ""])
def test_a_foreign_request_id_is_replaced(rid):
    r = get("/api/v1/health/live", headers={"x-request-id": rid})
    assert r.headers["x-request-id"] != rid and len(r.headers["x-request-id"]) == 36


@pytest.mark.parametrize(
    ("method", "path", "status", "allow"),
    [
        ("OPTIONS", "/api/v1/health/live", 405, "GET"),
        ("DELETE", "/api/v1/health/live", 405, "GET"),
        ("GET", "/api/v1/auth/login", 405, "POST"),  # declared, not implemented yet
        ("PATCH", "/api/v1/batches/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e", 405, "GET"),
        ("OPTIONS", "/api/v1/docs", 404, None),
        ("HEAD", "/api/v1/health/live", 200, None),
        ("GET", "/api/v1/health/live/", 404, None),
        ("GET", "/api/v1/Health/live", 404, None),
        ("GET", "/api/v1/health", 404, None),
        ("POST", "/api/v1/docs", 404, None),
    ],
)
def test_methods_and_strict_paths(method, path, status, allow):
    r = get(path, method)
    assert r.status == status
    assert r.headers.get("allow") == allow
    assert r.headers["x-backend"] == "django"
    if status >= 400:
        assert r.headers["content-type"] == "application/problem+json; charset=utf-8"


def test_docs_page_and_assets():
    page = get("/api/v1/docs")
    assert page.status == 200 and page.headers["content-type"] == "text/html; charset=utf-8"
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert get("/api/v1/docs/").status == 200
    assert get("/api/v1/docs/swagger-ui-bundle.js").headers["content-type"].startswith("text/javascript")
    assert get("/api/v1/docs/nope.js").status == 404
    assert b"url: '/api/v1/docs/openapi.json'" in get("/api/v1/docs/init.js").body


def req(xff=None, peer="172.18.0.5"):
    meta = {"REMOTE_ADDR": peer}
    if xff is not None:
        meta["HTTP_X_FORWARDED_FOR"] = xff
    return SimpleNamespace(META=meta, scope={"client": (peer, 1234)})


def test_client_ip_is_the_last_forwarded_hop():
    assert client_ip(req("1.2.3.4, 10.0.0.7")) == "10.0.0.7"
    assert client_ip(req("::ffff:10.0.0.1")) == "10.0.0.1"
    assert client_ip(req("not-an-ip")) == "172.18.0.5"
    assert client_ip(req()) == "172.18.0.5"
    assert client_ip(req(None, "::ffff:192.168.1.9")) == "192.168.1.9"
