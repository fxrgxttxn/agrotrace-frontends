"""
getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ and
MinIO concurrently under ONE deadline of HEALTH_TIMEOUT_MS counted from the start of the request (Express
routes.ts `probe()`): every probe still running at the deadline is `fail`, so the whole answer is bounded by about
HEALTH_TIMEOUT_MS whatever hangs. Each probe runs on its own short-lived daemon thread — a probe that hangs (a Redis
socket timeout, a slow S3) can never fill a shared pool and delay the probes of later requests. Any `fail` → 503
with the same body shape.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from django.db import connections
from rest_framework.response import Response

from agrotrace.core import config, sql
from agrotrace.core.views import ContractView

log = logging.getLogger("agrotrace.health")


def _db() -> None:
    try:
        sql.scalar("SELECT 1")
    finally:
        connections.close_all()  # this probe thread's pool connection goes back at once


def _redis() -> None:
    from agrotrace.infra import redis

    redis.client().ping()


def _rabbitmq() -> None:
    import kombu

    timeout = config.get().HEALTH_TIMEOUT_MS / 1000
    with kombu.Connection(config.get().RABBITMQ_URL, connect_timeout=timeout) as conn:
        conn.connect()


def _s3() -> None:
    from agrotrace.infra import s3

    s3.ping()


CHECKS: dict[str, Callable[[], None]] = {"db": _db, "redis": _redis, "rabbitmq": _rabbitmq, "s3": _s3}


def run_checks(checks: dict[str, Callable[[], None]], timeout_s: float) -> dict[str, str]:
    """`{name: ok|fail}`: all probes start at once; one deadline `timeout_s` from now for all of them."""
    results: dict[str, str] = {}
    done = {name: threading.Event() for name in checks}

    def probe(name: str, fn: Callable[[], None]) -> None:
        try:
            fn()
            results[name] = "ok"
        except Exception:
            results[name] = "fail"
        finally:
            done[name].set()

    for name, fn in checks.items():
        threading.Thread(target=probe, args=(name, fn), name=f"health-{name}", daemon=True).start()
    deadline = time.monotonic() + timeout_s
    out: dict[str, str] = {}
    for name in checks:
        finished = done[name].wait(max(0.0, deadline - time.monotonic()))
        out[name] = results.get(name, "fail") if finished else "fail"
        if out[name] != "ok":
            log.warning("readiness check failed", extra={"check": name})
    return out


class LiveView(ContractView):
    operation_id = "getHealthLive"

    def get(self, request):
        return Response({"status": "ok"})


class ReadyView(ContractView):
    operation_id = "getHealthReady"

    def get(self, request):
        checks = run_checks(CHECKS, config.get().HEALTH_TIMEOUT_MS / 1000)
        ok = all(v == "ok" for v in checks.values())
        return Response({"status": "ok" if ok else "fail", "checks": checks}, status=200 if ok else 503)
