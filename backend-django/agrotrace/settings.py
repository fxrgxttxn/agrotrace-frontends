"""
Django settings, derived from the validated process configuration (core.config: a bad variable stops the start here).

Layout:
- no django.contrib.auth/admin/sessions/messages/staticfiles; apps = DRF + `agrotrace.core` (managed = False models);
- the schema is dbmate's (db/migrations): Django migrations are disabled for every app, `migrate` is never run;
- one DB alias over APP_DATABASE_URL (role agrotrace_app, D-I8) with psycopg's pool (`DJANGO_DB_POOL_MAX` from the
  service's compose `environment:`, 5 s wait → 503, P61), `CONN_MAX_AGE = 0` (required with the pool), health checks
  on checkout (connections outlive `./at reset` from another worktree), statement/lock timeouts and UTC as connection
  `options` (never `SET` on a pooled connection); `ATOMIC_REQUESTS = False` (transactions are `core.tx.with_tx`);
- DRF: our renderer and negotiation only, no parsers (core.body), auth header class only, no throttling, the problem
  exception handler; `URL_FORMAT_OVERRIDE = None` (`?format=` belongs to the contract);
- strict routing (`APPEND_SLASH = False`, no CommonMiddleware), `ALLOWED_HOSTS = ['*']` (DisallowedHost would be an
  HTML 400), `DEBUG = False`, Django's own body limits off (core.body / core.multipart enforce the contract's);
- `SECRET_KEY` is derived from JWT_SECRET (HMAC) — .env.example has no Django key.
Test runs (pytest, the django:test hook) point the alias at TEST_DATABASE_URL (agrotrace_test_django).
"""

from __future__ import annotations

import hashlib
import hmac
import os
from urllib.parse import parse_qs, unquote, urlsplit

from agrotrace.core import config as app_config
from agrotrace.core import logging as app_logging

CONFIG = app_config.get()
PROCESS = os.environ.get("AGROTRACE_PROCESS", "api")

app_logging.configure(PROCESS)

DEBUG = False
ALLOWED_HOSTS = ["*"]
SECRET_KEY = hmac.new(CONFIG.JWT_SECRET.encode(), b"agrotrace:django-secret-key", hashlib.sha256).hexdigest()

INSTALLED_APPS = [
    "rest_framework",
    "agrotrace.core",
]

MIDDLEWARE = [
    "agrotrace.core.middleware.RequestIdMiddleware",
    "agrotrace.core.middleware.AccessLogMiddleware",
    "agrotrace.core.middleware.RawPathMiddleware",
    "agrotrace.core.middleware.MethodGuardMiddleware",
    "agrotrace.core.middleware.JsonBodyMiddleware",
]

ROOT_URLCONF = "agrotrace.urls"
ASGI_APPLICATION = "agrotrace.asgi.application"
APPEND_SLASH = False
TEMPLATES: list = []

USE_TZ = True
TIME_ZONE = "UTC"
USE_I18N = False

DATA_UPLOAD_MAX_MEMORY_SIZE = None
DATA_UPLOAD_MAX_NUMBER_FIELDS = None
DATA_UPLOAD_MAX_NUMBER_FILES = None
FILE_UPLOAD_MAX_MEMORY_SIZE = 12 * 1024 * 1024


def _database(url: str) -> dict:
    u = urlsplit(url)
    query = {k: v[-1] for k, v in parse_qs(u.query).items()}
    options: dict = {
        "options": (f"-c TimeZone=UTC -c statement_timeout={CONFIG.DB_STATEMENT_TIMEOUT_MS} "
                    f"-c lock_timeout={CONFIG.DB_LOCK_TIMEOUT_MS}"),
        "application_name": f"agrotrace-django-{PROCESS}",
        "pool": {
            "min_size": 0,
            "max_size": CONFIG.DJANGO_DB_POOL_MAX,
            "timeout": CONFIG.DB_CONNECT_TIMEOUT_MS / 1000,
            "name": f"django-{PROCESS}",
        },
    }
    if "sslmode" in query:
        options["sslmode"] = query["sslmode"]
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(u.path.lstrip("/")),
        "USER": unquote(u.username or ""),
        "PASSWORD": unquote(u.password or ""),
        "HOST": u.hostname or "",
        "PORT": str(u.port or 5432),
        "CONN_MAX_AGE": 0,
        "CONN_HEALTH_CHECKS": True,
        "ATOMIC_REQUESTS": False,
        "AUTOCOMMIT": True,
        "OPTIONS": options,
    }


DATABASES = {"default": _database(os.environ.get("TEST_DATABASE_URL") or CONFIG.APP_DATABASE_URL)}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


class _NoMigrations(dict):
    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return None


MIGRATION_MODULES = _NoMigrations()

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["agrotrace.core.drf.JsonRenderer"],
    "DEFAULT_PARSER_CLASSES": [],
    "DEFAULT_CONTENT_NEGOTIATION_CLASS": "agrotrace.core.drf.AlwaysJson",
    "DEFAULT_AUTHENTICATION_CLASSES": ["agrotrace.core.auth.BearerAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": [],
    "DEFAULT_THROTTLE_CLASSES": [],
    "DEFAULT_VERSIONING_CLASS": None,
    "UNAUTHENTICATED_USER": None,
    "UNAUTHENTICATED_TOKEN": None,
    "URL_FORMAT_OVERRIDE": None,
    "EXCEPTION_HANDLER": "agrotrace.core.problem.exception_handler",
}

LOGGING_CONFIG = None  # core.logging configured every logger above
