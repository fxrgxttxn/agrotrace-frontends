"""
Configuration and the connection budget (P61 as revised by SP4, D-I5): per process the peak number of connection
holders fits its pool, and Django's processes sum to 20 — the pool sizes are read from the `environment:` of the
services in docker-compose.yml (mounted by the django:test hook).
"""

import re
from pathlib import Path

import pytest
import yaml

from agrotrace.core import config

COMPOSE = Path(config.ROOT) / "docker-compose.yml"

BASE_ENV = {
    "APP_DATABASE_URL": "postgres://agrotrace_app:x@postgres:5432/agrotrace",
    "REDIS_URL": "redis://redis:6379/0",
    "RABBITMQ_URL": "amqp://u:p@rabbitmq:5672/",
    "S3_ENDPOINT": "http://minio:9000",
    "S3_ACCESS_KEY": "a",
    "S3_SECRET_KEY": "b",
    "S3_BUCKET": "agrotrace",
    "JWT_SECRET": "x" * 32,
    "PUBLIC_BASE_URL": "http://react-django.localhost/",
}


@pytest.fixture(scope="module")
def services():
    assert COMPOSE.is_file(), f"{COMPOSE} is not mounted (run ./at.sh django:test)"
    return yaml.safe_load(COMPOSE.read_text("utf-8"))["services"]


def env_of(services, name):
    return {k: str(v) for k, v in (services[name].get("environment") or {}).items()}


def test_pool_sizes_per_process_and_the_backend_total(services):
    api, worker, beat = (env_of(services, s) for s in ("api-django", "worker-django", "beat-django"))
    api_pool, sse_pool = int(api["DJANGO_DB_POOL_MAX"]), int(api["DJANGO_SSE_POOL_MAX"])
    worker_pool, beat_pool = int(worker["DJANGO_DB_POOL_MAX"]), int(beat["DJANGO_DB_POOL_MAX"])
    assert (api_pool, sse_pool, worker_pool, beat_pool) == (7, 2, 6, 4)
    # worker: Celery threads + notification send threads + the Telegram poller fit the pool.
    cmd = services["worker-django"]["command"]
    concurrency = int(cmd[cmd.index("-c") + 1])
    assert concurrency == config.WORKER_CONCURRENCY == 2
    assert cmd[cmd.index("-P") + 1] == "threads"
    assert concurrency + config.WORKER_DELIVERY_SLOTS + config.WORKER_POLLERS <= worker_pool
    # beat: one connection per job (its advisory lock, its tick transactions, the stale notification sends).
    assert len(config.BEAT_JOBS) <= beat_pool
    # api: one uvicorn process (the LISTEN session and the metrics are per process).
    from agrotrace import serve

    assert services["api-django"]["command"] == ["python", "-m", "agrotrace.serve"]
    assert serve.uvicorn_options(config.get())["workers"] == 1
    total = api_pool + sse_pool + config.API_LISTEN_SESSIONS + worker_pool + beat_pool
    assert total == config.BACKEND_CONNECTION_BUDGET == 20


def test_every_process_connects_as_the_app_role(services):
    for s in ("api-django", "worker-django", "beat-django"):
        assert env_of(services, s)["APP_DATABASE_URL"] == "${APP_DATABASE_URL}"
        assert "DATABASE_URL" not in env_of(services, s)
        assert services[s]["env_file"] == [".env"]
        assert "ports" not in services[s]
    assert services["api-django"]["expose"] == ["9464"]


def test_the_api_settings_use_the_pool_of_the_environment():
    from django.conf import settings

    db = settings.DATABASES["default"]
    assert db["CONN_MAX_AGE"] == 0 and db["CONN_HEALTH_CHECKS"] is True and db["ATOMIC_REQUESTS"] is False
    pool = db["OPTIONS"]["pool"]
    assert pool["max_size"] == config.get().DJANGO_DB_POOL_MAX
    assert pool["timeout"] == 5
    assert re.search(r"statement_timeout=30000", db["OPTIONS"]["options"])
    assert re.search(r"lock_timeout=10000", db["OPTIONS"]["options"])
    assert re.search(r"TimeZone=UTC", db["OPTIONS"]["options"])


@pytest.mark.parametrize(
    "value",
    ['{"nope": 5}', '{"user": 0}', "not json", '{"user": 1.5}', '{"user": true}', "[1]"],
)
def test_a_bad_rate_limit_override_stops_the_start(value):
    with pytest.raises(config.ConfigError) as e:
        config.load({**BASE_ENV, "RATE_LIMIT_OVERRIDES": value})
    assert "RATE_LIMIT_OVERRIDES" in str(e.value)


def test_rate_limit_overrides_and_defaults():
    c = config.load({**BASE_ENV, "RATE_LIMIT_OVERRIDES": '{"user":100000,"login-ip":100000,"complaint-ip":100000}'})
    assert c.RATE_LIMIT_OVERRIDES == {"user": 100000, "login-ip": 100000, "complaint-ip": 100000}
    assert c.SCHEDULER_TICK_MS == 300000
    assert c.REPORT_MAX_ROWS == 50000
    assert c.METRICS_PORT == 9464
    assert c.PUBLIC_BASE_URL == "http://react-django.localhost"
    assert c.TELEGRAM_BOT_TOKEN is None  # empty counts as unset
    assert config.load({**BASE_ENV, "SCHEDULER_TICK_MS": "1000"}).SCHEDULER_TICK_MS == 1000


def test_missing_and_malformed_variables_are_all_listed():
    env = {k: v for k, v in BASE_ENV.items() if k != "REDIS_URL"}
    with pytest.raises(config.ConfigError) as e:
        config.load({**env, "JWT_SECRET": "short", "SCHEDULER_TICK_MS": "5", "APP_DATABASE_URL": "mysql://x"})
    text = str(e.value)
    for name in ("REDIS_URL", "JWT_SECRET", "SCHEDULER_TICK_MS", "APP_DATABASE_URL"):
        assert name in text
