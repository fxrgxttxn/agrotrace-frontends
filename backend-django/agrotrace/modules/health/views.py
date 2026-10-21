"""
getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ and
MinIO concurrently, each bounded by HEALTH_TIMEOUT_MS; any `fail` → 503 with the same body shape.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from django.db import connections
from rest_framework.response import Response

from agrotrace.core import config, sql
from agrotrace.core.views import ContractView

log = logging.getLogger("agrotrace.health")

_probes = ThreadPoolExecutor(max_workers=8, thread_name_prefix="health")


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


CHECKS = {"db": _db, "redis": _redis, "rabbitmq": _rabbitmq, "s3": _s3}


class LiveView(ContractView):
    operation_id = "getHealthLive"

    def get(self, request):
        return Response({"status": "ok"})


class ReadyView(ContractView):
    operation_id = "getHealthReady"

    def get(self, request):
        timeout = config.get().HEALTH_TIMEOUT_MS / 1000
        futures = {name: _probes.submit(fn) for name, fn in CHECKS.items()}
        checks: dict[str, str] = {}
        for name, fut in futures.items():
            try:
                fut.result(timeout=timeout)
                checks[name] = "ok"
            except (FutureTimeout, Exception):
                checks[name] = "fail"
                log.warning("readiness check failed", extra={"check": name})
        ok = all(v == "ok" for v in checks.values())
        return Response({"status": "ok" if ok else "fail", "checks": checks}, status=200 if ok else 503)
