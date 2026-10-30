"""
Prometheus metrics of the api process (spec 14.5; contract info.description «Мониторинг»; P54), the port of
backend-express/src/infra/metrics.ts: the text format on a listener of its own, `METRICS_PORT` (9464) `GET /metrics` —
never on the API port, so the gateway (which proxies `/api/` of port 8000 only) cannot expose it. One process
(uvicorn `--workers 1`), so prometheus_client's multiprocess mode is not needed. Every series carries
`backend="django"`.

- `http_request_duration_seconds` (histogram; method, route = the contract path template or `unmatched`, status) —
  observed once per request by `instrument` (the outermost ASGI wrapper): when the last body chunk is sent, or when the
  client goes away first — `status="499"` if nothing was sent yet (Express: review M7d);
- `http_request_errors_total` (counter; method, route, status) — responses with status ≥ 500 (499 is not one);
- `queue_messages` (gauge; queue) — messages ready in `agrotrace.django.jobs`, a passive `queue_declare` at scrape time;
- `recalls_open` (gauge) — recalls in status OPEN (not deleted), one SQL count at scrape time;
- prometheus_client's process / platform / GC collectors (implementation-defined, like prom-client's defaults).

django-prometheus (spec table §8.7) is not used: its names and labels are not the contract's required series (P54).

Bounded scrape reads (P61): each gauge is read by at most ONE thread at a time (a lock), and a scrape waits for it at
most 2 s (`SCRAPE_TIMEOUT_S`) — then the value is NaN (unknown), never the last good value shown as current. So
the metrics server holds at most one connection of the api pool, whatever the number or speed of scrapes, and a hung
broker or exhausted pool never piles up threads.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Callable, Iterable
from functools import cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import prometheus_client
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.core import GaugeMetricFamily, Metric
from prometheus_client.registry import Collector

BACKEND = "django"
API_PREFIX = "/api/v1"
SCRAPE_TIMEOUT_S = 2.0
#: `method` label values; anything else is `other` (bounded cardinality, Express review M7e).
METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
#: The buckets of backend-express (prom-client's defaults), not prometheus_client's.
BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)

log = logging.getLogger("agrotrace.metrics")

# prom-client exposes no `_created` series; neither do we.
prometheus_client.disable_created_metrics()


# ── route label ─────────────────────────────────────────────────────────────────────────────────────────────────────

@cache
def _templates() -> tuple[tuple[str, tuple[str, ...]], ...]:
    from agrotrace.core import contract

    routes = [(t, tuple(t.split("/"))) for t in contract.load().doc["paths"]]
    # Fewest parameters first (stable): a literal template wins over a parameterised one.
    routes.sort(key=lambda r: sum(1 for s in r[1] if s.startswith("{")))
    return tuple(routes)


def route_label(path: str) -> str:
    """Request path (query string ignored) → the contract path template it matches, without `/api/v1`
    (`/api/v1/batches/<uuid>` → `/batches/{id}`), a literal template winning over a parameterised one; none →
    `unmatched`. Bounded cardinality whatever clients send."""
    path = path.split("?", 1)[0]
    if not path.startswith(API_PREFIX + "/"):
        return "unmatched"
    segments = path[len(API_PREFIX):].split("/")
    for template, parts in _templates():
        if len(parts) == len(segments) and all(
            (len(seg) > 0) if part.startswith("{") else part == seg for part, seg in zip(parts, segments, strict=True)
        ):
            return template
    return "unmatched"


# ── registry ────────────────────────────────────────────────────────────────────────────────────────────────────────

_inner = CollectorRegistry(auto_describe=True)
DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP response time of the API by method, contract route and status",
    ["method", "route", "status"],
    buckets=BUCKETS,
    registry=_inner,
)
ERRORS = Counter(
    "http_request_errors_total",
    "HTTP responses with status >= 500 by method, contract route and status",
    ["method", "route", "status"],
    registry=_inner,
)
prometheus_client.ProcessCollector(registry=_inner)
prometheus_client.PlatformCollector(registry=_inner)
prometheus_client.GCCollector(registry=_inner)


class BoundedRead:
    """`fn()` read by at most one thread at a time; a caller waits at most `timeout` s in all (for the lock and the
    value) — NaN on a timeout, an error or None."""

    def __init__(self, name: str, fn: Callable[[], float | int | None], timeout: float = SCRAPE_TIMEOUT_S):
        self.name = name
        self.fn = fn
        self.timeout = timeout
        self._lock = threading.Lock()

    def read(self) -> float:
        deadline = time.monotonic() + self.timeout
        if not self._lock.acquire(timeout=self.timeout):
            log.warning("metrics: previous read still in flight", extra={"gauge": self.name})
            return math.nan
        box: dict[str, object] = {}
        done = threading.Event()

        def run() -> None:
            try:
                box["value"] = self.fn()
            except Exception as e:
                box["err"] = e
            finally:
                done.set()
                self._lock.release()

        try:
            threading.Thread(target=run, name=f"metrics-{self.name}", daemon=True).start()
        except Exception:
            self._lock.release()
            raise
        if not done.wait(max(0.0, deadline - time.monotonic())):
            log.warning("metrics: read timed out", extra={"gauge": self.name})
            return math.nan
        if "err" in box:
            log.warning("metrics: read failed", extra={"gauge": self.name, "err": str(box["err"])})
            return math.nan
        value = box.get("value")
        return math.nan if value is None else float(value)  # type: ignore[arg-type]


def _queue_ready() -> int | None:
    from agrotrace.infra import amqp

    return amqp.queue_ready_count(acquire_timeout=SCRAPE_TIMEOUT_S)


def _recalls_open() -> int:
    from agrotrace.core import sql

    return int(sql.scalar("SELECT count(*) FROM recalls WHERE status = 'OPEN' AND deleted_at IS NULL"))


def jobs_queue() -> str:
    from agrotrace.celery_app import QUEUE

    return QUEUE


QUEUE_READ = BoundedRead("queue_messages", _queue_ready)
RECALLS_READ = BoundedRead("recalls_open", _recalls_open)


class _ScrapeGauges(Collector):
    """The two gauges read at scrape time."""

    def describe(self) -> Iterable[Metric]:
        yield GaugeMetricFamily("queue_messages", "", labels=["queue"])
        yield GaugeMetricFamily("recalls_open", "")

    def collect(self) -> Iterable[Metric]:
        q = GaugeMetricFamily("queue_messages",
                              "Messages ready in the jobs queue of the backend (RabbitMQ), read at scrape time",
                              labels=["queue"])
        q.add_metric([jobs_queue()], QUEUE_READ.read())
        yield q
        r = GaugeMetricFamily("recalls_open", "Recalls in status OPEN (not deleted), read at scrape time")
        r.add_metric([], RECALLS_READ.read())
        yield r


_inner.register(_ScrapeGauges())


class _WithBackend(Collector):
    """Every family of the inner registry with `backend="django"` on each sample (prom-client's default labels)."""

    def __init__(self, inner: CollectorRegistry):
        self.inner = inner

    def collect(self) -> Iterable[Metric]:
        for family in self.inner.collect():
            out = Metric(family.name, family.documentation, family.type, family.unit)
            out.samples = [s._replace(labels={**s.labels, "backend": BACKEND}) for s in family.samples]
            yield out


REGISTRY = CollectorRegistry(auto_describe=False)
REGISTRY.register(_WithBackend(_inner))


def render() -> bytes:
    return generate_latest(REGISTRY)


# ── HTTP observation (ASGI) ─────────────────────────────────────────────────────────────────────────────────────────

def _observe(method: str, route: str, status: int, seconds: float) -> None:
    labels = (method if method in METHODS else "other", route, str(status))
    DURATION.labels(*labels).observe(seconds)
    if status >= 500 and status != 499:
        ERRORS.labels(*labels).inc()


def instrument(app):
    """ASGI wrapper of the http scope: one observation per request — at the last body chunk, at a client disconnect
    (499 when no response started), or when the app returns or fails (500 when no response started)."""

    async def wrapped(scope, receive, send):
        if scope.get("type") != "http":
            return await app(scope, receive, send)
        started = time.perf_counter()
        raw = scope.get("raw_path")
        path = raw.decode("latin-1") if raw is not None else scope.get("path", "")
        method, route = scope.get("method", ""), route_label(path)
        state: dict[str, int | None | bool] = {"status": None, "done": False}

        def observe(fallback: int) -> None:
            if state["done"]:
                return
            state["done"] = True
            status = state["status"]
            _observe(method, route, status if isinstance(status, int) else fallback, time.perf_counter() - started)

        async def tracked_send(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                observe(499)

        async def tracked_receive():
            message = await receive()
            if message["type"] == "http.disconnect":
                observe(499)
            return message

        try:
            await app(scope, tracked_receive, tracked_send)
        except BaseException:
            observe(500)
            raise
        observe(499)

    return wrapped


# ── the /metrics listener ───────────────────────────────────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    server_version = "agrotrace-metrics"
    sys_version = ""

    def _answer(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _route(self) -> None:
        if self.command != "GET" or self.path.split("?", 1)[0] != "/metrics":
            self._answer(404, b"not found\n", "text/plain; charset=utf-8")
            return
        try:
            body = render()
        except Exception as e:
            log.error("metrics: scrape failed", exc_info=e)
            self._answer(500, b"scrape failed\n", "text/plain; charset=utf-8")
            return
        self._answer(200, body, CONTENT_TYPE_LATEST)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _route

    def log_message(self, format, *args):  # noqa: A002 - scrapes are not access-logged
        return


class MetricsServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_metrics_server(port: int, host: str = "0.0.0.0") -> MetricsServer:  # noqa: S104 - inside the compose network
    """Starts the `/metrics` listener on `port` in a daemon thread; returns the server (`.shutdown()` stops it)."""
    server = MetricsServer((host, port), _Handler)
    threading.Thread(target=server.serve_forever, name="metrics-server", daemon=True).start()
    log.info("metrics listening", extra={"port": server.server_address[1]})
    return server
