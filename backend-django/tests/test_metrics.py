"""
Prometheus metrics of the api process (core.metrics, P54; port of backend-express/src/infra/metrics.ts): the route
label, the method label, one observation per request (499 for a client gone before the response), the error counter,
NaN for a gauge that cannot be read (bounded, at most one read in flight), `backend="django"` on every series of the
required families, the listener on its own port (GET /metrics only).
"""

from __future__ import annotations

import asyncio
import math
import re
import threading
import time
import urllib.error
import urllib.request

import pytest
from django.test import override_settings

from agrotrace.core import metrics
from tests.asgi_client import call

REQUIRED = ("http_request_duration_seconds", "http_request_errors_total", "queue_messages", "recalls_open")


def count(method: str, route: str, status: str) -> float:
    v = metrics.REGISTRY.get_sample_value(
        "http_request_duration_seconds_count",
        {"method": method, "route": route, "status": status, "backend": "django"},
    )
    return v or 0.0


def errors(method: str, route: str, status: str) -> float:
    v = metrics.REGISTRY.get_sample_value(
        "http_request_errors_total", {"method": method, "route": route, "status": status, "backend": "django"}
    )
    return v or 0.0


@pytest.fixture
def gauges(monkeypatch):
    """Scrape-time gauges without the stand's broker and DB."""
    monkeypatch.setattr(metrics.QUEUE_READ, "fn", lambda: 3)
    monkeypatch.setattr(metrics.RECALLS_READ, "fn", lambda: 2)


# ── route label ─────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("path", "label"), [
    ("/api/v1/dictionaries/products/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e/image", "/dictionaries/products/{id}/image"),
    ("/api/v1/batches/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", "/batches/{id}"),
    ("/api/v1/health/live", "/health/live"),
    ("/api/v1/health/live?x=1", "/health/live"),
    ("/api/v1/no/such/path/for-metrics", "unmatched"),
    ("/api/v1/batches/", "unmatched"),
    ("/api/v1", "unmatched"),
    ("/metrics", "unmatched"),
    ("/", "unmatched"),
])
def test_route_label(path, label):
    assert metrics.route_label(path) == label


def test_every_template_labels_itself_a_literal_one_winning_over_a_parameterised_one():
    from agrotrace.core import contract

    templates = list(contract.load().doc["paths"])
    concrete = {t: re.sub(r"\{[^}]+\}", "x1", t) for t in templates}
    for t in templates:
        assert metrics.route_label("/api/v1" + concrete[t]) == t
    # The contract has shadowed literals (e.g. /dictionaries/{name}/import under /dictionaries/{name}/{id}).
    assert metrics.route_label("/api/v1/dictionaries/products/import") == "/dictionaries/{name}/import"
    assert metrics.route_label("/api/v1/dictionaries/products/0b1c2d3e") == "/dictionaries/{name}/{id}"


# ── HTTP observation ────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_request_is_observed_once_by_method_route_and_status():
    before = count("GET", "/health/live", "200")
    r = asyncio.run(call("GET", "/api/v1/health/live"))
    assert r.status == 200
    assert count("GET", "/health/live", "200") == before + 1


def test_an_unknown_method_is_other():
    before = count("other", "/health/live", "405")
    r = asyncio.run(call("PROPFIND", "/api/v1/health/live"))
    assert r.status == 405
    assert count("other", "/health/live", "405") == before + 1


def test_a_path_outside_the_contract_is_unmatched():
    before = count("GET", "unmatched", "404")
    r = asyncio.run(call("GET", "/api/v1/no/such/path/for-metrics"))
    assert r.status == 404
    assert count("GET", "unmatched", "404") == before + 1


@override_settings(ROOT_URLCONF="tests.asgi_urls")
def test_a_client_gone_before_the_response_is_499_and_not_an_error():
    before, before_err = count("GET", "unmatched", "499"), errors("GET", "unmatched", "499")
    r = asyncio.run(call("GET", "/api/v1/test/sleep", disconnect_after=0.05))
    assert r.status is None
    assert count("GET", "unmatched", "499") == before + 1
    assert errors("GET", "unmatched", "499") == before_err


def test_5xx_increments_the_error_counter_and_4xx_does_not():
    async def app_of(status):
        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": status, "headers": []})
            await send({"type": "http.response.body", "body": b"x"})
        return metrics.instrument(app)

    async def drive(status):
        app = await app_of(status)
        return await call("GET", "/api/v1/health/ready", app=app)

    b503, b400 = errors("GET", "/health/ready", "503"), errors("GET", "/health/ready", "400")
    asyncio.run(drive(503))
    asyncio.run(drive(400))
    assert errors("GET", "/health/ready", "503") == b503 + 1
    assert errors("GET", "/health/ready", "400") == b400


def test_an_app_failing_before_a_response_is_a_500():
    async def app(scope, receive, send):
        raise RuntimeError("boom")

    before = errors("POST", "/health/ready", "500")
    with pytest.raises(RuntimeError):
        asyncio.run(call("POST", "/api/v1/health/ready", app=metrics.instrument(app)))
    assert errors("POST", "/health/ready", "500") == before + 1


def test_a_streamed_response_is_observed_at_its_last_chunk():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"a", "more_body": True})
        await send({"type": "http.response.body", "body": b"b", "more_body": False})

    before = count("GET", "/events/stream", "200")
    asyncio.run(call("GET", "/api/v1/events/stream", app=metrics.instrument(app)))
    assert count("GET", "/events/stream", "200") == before + 1


# ── gauges ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_an_unreadable_gauge_is_nan(monkeypatch):
    def boom():
        raise OSError("broker down")

    monkeypatch.setattr(metrics.QUEUE_READ, "fn", lambda: None)  # queue_ready_count's "unknown"
    monkeypatch.setattr(metrics.RECALLS_READ, "fn", boom)
    text = metrics.render().decode()
    assert re.search(r'^queue_messages\{.*queue="agrotrace\.django\.jobs".*\} NaN$', text, re.M), text
    assert re.search(r"^recalls_open\{.*\} NaN$", text, re.M), text


def test_a_slow_read_is_nan_after_the_timeout_and_never_runs_twice_at_once(monkeypatch):
    release = threading.Event()
    running = []

    def slow():
        running.append(1)
        release.wait(5)
        return 7

    read = metrics.BoundedRead("slow", slow, timeout=0.2)
    t0 = time.monotonic()
    assert math.isnan(read.read())
    assert math.isnan(read.read())  # waits for the in-flight read's lock, then gives up — no second thread
    assert time.monotonic() - t0 < 1.0
    assert len(running) == 1
    release.set()
    deadline = time.monotonic() + 2
    while read._lock.locked() and time.monotonic() < deadline:
        time.sleep(0.01)
    read.fn = lambda: 4
    assert read.read() == 4.0


def test_the_queue_gauge_reads_with_a_bounded_broker_wait(monkeypatch):
    from agrotrace.infra import amqp

    seen = {}

    def fake(queue=None, acquire_timeout=None):
        seen["timeout"] = acquire_timeout
        return 5

    monkeypatch.setattr(amqp, "queue_ready_count", fake)
    assert metrics._queue_ready() == 5
    assert seen["timeout"] == metrics.SCRAPE_TIMEOUT_S == 2.0


def test_every_series_of_the_required_families_has_backend_django(gauges):
    asyncio.run(call("GET", "/api/v1/health/live"))
    text = metrics.render().decode()
    for family, kind in zip(REQUIRED, ("histogram", "counter", "gauge", "gauge"), strict=True):
        assert re.search(rf"^# TYPE {family} {kind}$", text, re.M), family
    lines = [ln for ln in text.splitlines() if re.match(r"^(" + "|".join(REQUIRED) + r")[_{ ]", ln)]
    assert lines
    for ln in lines:
        assert 'backend="django"' in ln, ln
    assert "_created" not in text
    # Express's buckets (prom-client defaults).
    les = re.findall(r'^http_request_duration_seconds_bucket\{[^}]*route="/health/live"[^}]*status="200"[^}]*\}', text,
                     re.M)
    bounds = sorted({re.search(r'le="([^"]+)"', ln).group(1) for ln in les}, key=lambda v: float(v))
    assert [float(b) for b in bounds] == [*metrics.BUCKETS, math.inf]


# ── the listener ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_listener_serves_get_metrics_only(gauges):
    server = metrics.start_metrics_server(0, host="127.0.0.1")
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        with urllib.request.urlopen(base + "/metrics", timeout=5) as res:
            assert res.status == 200
            assert res.headers["Content-Type"].startswith("text/plain")
            assert b'recalls_open{backend="django"} 2.0' in res.read()
        for method, path in (("GET", "/"), ("GET", "/metricsx"), ("POST", "/metrics")):
            req = urllib.request.Request(base + path, method=method, data=b"" if method == "POST" else None)
            with pytest.raises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(req, timeout=5)
            assert e.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_metrics_are_not_on_the_api_port():
    r = asyncio.run(call("GET", "/api/v1/metrics"))
    assert r.status == 404 and r.json()["code"] == "NOT_FOUND"
    r = asyncio.run(call("GET", "/metrics"))
    assert r.status == 404
