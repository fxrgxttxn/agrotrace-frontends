"""
Process configuration: the environment (docker-compose `env_file: .env` + the service's `environment:`), validated once
at start, as backend-express/src/config.ts. A missing or malformed variable stops the process with one line per
problem (ConfigError) — never a half-configured server. Empty strings count as unset (compose passes `VAR=` as "").

Connection budget (P61 as revised by SP4, D-I5): every process holds at most its pool; Django's 20 =
api (`DJANGO_DB_POOL_MAX` 7 + `DJANGO_SSE_POOL_MAX` 2 + the LISTEN session 1) + worker 6 + beat 4. The pool sizes are
set per service in docker-compose.yml (never in .env); the constants below are the holders each process may run.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

#: Repository root (the image mirrors its layout under /app): contracts/, packages/i18n/locales, assets/.
ROOT = Path(os.environ.get("AGROTRACE_ROOT") or Path(__file__).resolve().parents[3])

# ── Connection holders per process (P61, D-I5); test_config.py checks them against docker-compose.yml ──
#: api: one SSE LISTEN session outside both pools (sse/hub.py).
API_LISTEN_SESSIONS = 1
#: worker: Celery thread pool size (`celery … worker -P threads -c 2`).
WORKER_CONCURRENCY = 2
#: worker: notification send threads (Task 12) — a connection only to claim/record, released during SMTP/Telegram.
WORKER_DELIVERY_SLOTS = 2
#: worker: the Telegram getUpdates poller thread (Task 12).
WORKER_POLLERS = 1
#: beat: one thread and one connection per job; `notification-delivery` sends synchronously on its own connection.
BEAT_JOBS = ("lab-escalation", "recall-task-overdue", "notification-delivery", "outbox-sweeper")
#: Django's share of the stand-wide budget (contract «Бюджет соединений с PostgreSQL»).
BACKEND_CONNECTION_BUDGET = 20


class ConfigError(Exception):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("invalid configuration:\n" + "\n".join(f"  - {p}" for p in problems))


def rate_scopes() -> list[str]:
    rules = json.loads((ROOT / "contracts" / "rules" / "rate-limits.json").read_text("utf-8"))
    return [limit["scope"] for limit in rules["limits"]]


@dataclass(frozen=True)
class Config:
    APP_DATABASE_URL: str
    REDIS_URL: str
    RABBITMQ_URL: str
    S3_ENDPOINT: str
    S3_ACCESS_KEY: str
    S3_SECRET_KEY: str
    S3_BUCKET: str
    JWT_SECRET: str
    PUBLIC_BASE_URL: str
    S3_REGION: str = "us-east-1"
    PORT: int = 8000
    METRICS_PORT: int = 9464
    LOG_LEVEL: str = "info"
    DJANGO_DB_POOL_MAX: int = 7
    DJANGO_SSE_POOL_MAX: int = 2
    DB_CONNECT_TIMEOUT_MS: int = 5000
    DB_STATEMENT_TIMEOUT_MS: int = 30000
    DB_LOCK_TIMEOUT_MS: int = 10000
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 1025
    SMTP_FROM: str = "AgroTrace <noreply@agrotrace.local>"
    DADATA_API_KEY: str | None = None
    DADATA_URL: str = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
    DADATA_TIMEOUT_MS: int = 3000
    RATE_LIMIT_OVERRIDES: Mapping[str, int] = field(default_factory=dict)
    TELEGRAM_BOT_TOKEN: str | None = None
    TELEGRAM_BOT_USERNAME: str = "agrotrace_bot"
    TELEGRAM_API_URL: str = "https://api.telegram.org"
    MERCURY_URL: str = "http://mercury-mock:8080"
    MERCURY_TIMEOUT_MS: int = 10000
    MERCURY_RETRY_BASE_MS: int = 2000
    MERCURY_FAIL_PRODUCT_CODES: tuple[str, ...] = ()
    MERCURY_FAIL_MODE: str = "500"
    SCHEDULER_TICK_MS: int = 300_000
    REPORT_MAX_ROWS: int = 50_000
    HEALTH_TIMEOUT_MS: int = 2000
    SHUTDOWN_TIMEOUT_MS: int = 10000


_INTS: dict[str, tuple[int, int]] = {
    "PORT": (1, 65535),
    "METRICS_PORT": (1, 65535),
    "DJANGO_DB_POOL_MAX": (1, 200),
    "DJANGO_SSE_POOL_MAX": (1, 200),
    "DB_CONNECT_TIMEOUT_MS": (100, 60000),
    "DB_STATEMENT_TIMEOUT_MS": (100, 600000),
    "DB_LOCK_TIMEOUT_MS": (100, 600000),
    "SMTP_PORT": (1, 65535),
    "DADATA_TIMEOUT_MS": (100, 30000),
    "MERCURY_TIMEOUT_MS": (100, 60000),
    "MERCURY_RETRY_BASE_MS": (1, 60000),
    "SCHEDULER_TICK_MS": (100, 3_600_000),
    "REPORT_MAX_ROWS": (1, 50_000),
    "HEALTH_TIMEOUT_MS": (100, 30000),
    "SHUTDOWN_TIMEOUT_MS": (0, 120000),
}
_URLS: dict[str, tuple[str, ...]] = {
    "APP_DATABASE_URL": ("postgres", "postgresql"),
    "REDIS_URL": ("redis", "rediss"),
    "RABBITMQ_URL": ("amqp", "amqps"),
    "S3_ENDPOINT": ("http", "https"),
    "PUBLIC_BASE_URL": ("http", "https"),
    "DADATA_URL": ("http", "https"),
    "TELEGRAM_API_URL": ("http", "https"),
    "MERCURY_URL": ("http", "https"),
}
_REQUIRED = ("APP_DATABASE_URL", "REDIS_URL", "RABBITMQ_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY",
             "S3_BUCKET", "JWT_SECRET", "PUBLIC_BASE_URL")
_STRIP_SLASH = ("PUBLIC_BASE_URL", "TELEGRAM_API_URL", "MERCURY_URL")


def parse_rate_limit_overrides(raw: str) -> dict[str, int]:
    """P10/P41: JSON `{"<scope>": <integer >= 1>}` over the scopes of contracts/rules/rate-limits.json."""
    scopes = rate_scopes()
    try:
        value = json.loads(raw)
    except ValueError:
        raise ValueError('must be a JSON object {"<scope>": <limit>}') from None
    # A JSON number is a JS number: 5.0 is the integer 5 (Zod int), true is not a number.
    def integral(v: object) -> bool:
        return (type(v) is int) or (type(v) is float and v.is_integer())

    ok = isinstance(value, dict) and all(k in scopes and integral(v) and v >= 1 for k, v in value.items())
    if not ok:
        raise ValueError(f"must map scopes ({', '.join(scopes)}) to integers >= 1")
    return {k: int(v) for k, v in value.items()}


def load(env: Mapping[str, str] | None = None) -> Config:
    """Parses the environment; raises ConfigError listing every problem (`VARIABLE: message`)."""
    src = {k: v for k, v in (os.environ if env is None else env).items() if v is not None and v != ""}
    problems: list[str] = []
    values: dict[str, object] = {}
    for name in _REQUIRED:
        if name not in src:
            problems.append(f"{name}: required")
    for name, schemes in _URLS.items():
        if name in src:
            try:
                ok = urlsplit(src[name]).scheme in schemes and bool(urlsplit(src[name]).netloc)
            except ValueError:
                ok = False
            if not ok:
                problems.append(f"{name}: must be a {' or '.join(s + ':' for s in schemes)} URL")
    for name, (lo, hi) in _INTS.items():
        if name in src:
            raw = src[name]
            if not re.fullmatch(r"-?[0-9]+", raw.strip()) or not lo <= int(raw) <= hi:
                problems.append(f"{name}: must be an integer in [{lo}, {hi}]")
            else:
                values[name] = int(raw)
    if "JWT_SECRET" in src and len(src["JWT_SECRET"]) < 32:
        problems.append("JWT_SECRET: must be at least 32 characters")
    if "LOG_LEVEL" in src and src["LOG_LEVEL"] not in ("fatal", "error", "warn", "info", "debug", "trace", "silent"):
        problems.append("LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace, silent")
    if "MERCURY_FAIL_MODE" in src and src["MERCURY_FAIL_MODE"] not in ("500", "timeout"):
        problems.append("MERCURY_FAIL_MODE: must be 500 or timeout")
    if "TELEGRAM_BOT_USERNAME" in src and not re.fullmatch(r"[A-Za-z0-9_]{5,32}", src["TELEGRAM_BOT_USERNAME"]):
        problems.append("TELEGRAM_BOT_USERNAME: must be a Telegram username without @ (5-32 of A-Z a-z 0-9 _)")
    if "RATE_LIMIT_OVERRIDES" in src:
        try:
            values["RATE_LIMIT_OVERRIDES"] = parse_rate_limit_overrides(src["RATE_LIMIT_OVERRIDES"])
        except ValueError as e:
            problems.append(f"RATE_LIMIT_OVERRIDES: {e}")
    if problems:
        raise ConfigError(problems)
    for name in ("APP_DATABASE_URL", "REDIS_URL", "RABBITMQ_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY",
                 "S3_BUCKET", "S3_REGION", "JWT_SECRET", "PUBLIC_BASE_URL", "LOG_LEVEL", "SMTP_HOST", "SMTP_FROM",
                 "DADATA_API_KEY", "DADATA_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_API_URL",
                 "MERCURY_URL", "MERCURY_FAIL_MODE"):
        if name in src:
            values[name] = src[name].rstrip("/") if name in _STRIP_SLASH else src[name]
    if "MERCURY_FAIL_PRODUCT_CODES" in src:
        values["MERCURY_FAIL_PRODUCT_CODES"] = tuple(
            x.strip() for x in src["MERCURY_FAIL_PRODUCT_CODES"].split(",") if x.strip()
        )
    return Config(**values)  # type: ignore[arg-type]


_config: Config | None = None


def get() -> Config:
    """The process configuration (loaded once; settings.py loads it first, so a bad value stops the start)."""
    global _config
    if _config is None:
        _config = load()
    return _config
