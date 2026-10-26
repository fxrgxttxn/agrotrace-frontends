"""
JSON log lines on stdout (structlog over the standard library, so Django's, uvicorn's and Celery's records come out
the same way): `time`, `level`, `msg`, `backend: django`, `process`, `requestId` of the current request (or of the
event a worker handles) and the record's fields. Secrets never reach the logs (P8): the values of SECRET_KEYS are
`***` at any depth, whatever a caller passes in.
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import structlog

#: Keys whose values never reach the logs (backend-express/src/logger.ts SECRET_KEYS), compared case-insensitively.
SECRET_KEYS = frozenset(k.lower() for k in (
    "password", "newPassword", "currentPassword", "token", "accessToken", "refreshToken", "access_token", "secret",
    "totpSecret", "authorization", "cookie", "set-cookie", "idempotencyKey", "refresh", "totp", "altcha", "sig",
))
MASK = "***"

_LEVELS = {"fatal": logging.CRITICAL, "error": logging.ERROR, "warn": logging.WARNING, "info": logging.INFO,
           "debug": logging.DEBUG, "trace": logging.DEBUG, "silent": logging.CRITICAL + 10}

#: Attributes of a LogRecord that are not user fields.
_RECORD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", (), None)).keys()) | {"message", "asctime"}


def mask(value: Any, depth: int = 0) -> Any:
    """`value` with every SECRET_KEYS entry replaced by `***`, at any depth."""
    if depth > 32:
        return value
    if isinstance(value, Mapping):
        return {k: (MASK if isinstance(k, str) and k.lower() in SECRET_KEYS else mask(v, depth + 1))
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [mask(v, depth + 1) for v in value]
    return value


def _now(_, __, event: dict) -> dict:
    # Wall clock of the log line only (never written data): allowed by test_static_guards.
    event["time"] = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return event


def _context(_, __, event: dict) -> dict:
    from agrotrace.core import context

    c = context.current()
    rid = (c.request_id or c.event_request_id) if c else None
    if rid and "requestId" not in event:
        event["requestId"] = rid
    return event


def _plain(value: Any, depth: int = 0) -> bool:
    """Whether `value` is plain JSON data (scalars, str-keyed dicts, lists/tuples of them). Anything else — Django's
    `request` (its repr carries the query string: access_token, sig/exp), an ASGI scope object, a socket — is never
    copied into a line: `str(obj)` of a library object can hold a secret that `mask()` cannot see (P8)."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return True
    if depth > 32:
        return False
    if isinstance(value, Mapping):
        return all(isinstance(k, str) and _plain(v, depth + 1) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return all(_plain(v, depth + 1) for v in value)
    return False


def _record_fields(_, __, event: dict) -> dict:
    record: logging.LogRecord | None = event.get("_record")
    if record is not None:
        for k, v in vars(record).items():
            if k not in _RECORD_ATTRS and not k.startswith("_") and k not in event and _plain(v):
                event[k] = v
    return event


def _mask(_, __, event: dict) -> dict:
    return mask(event)


def _finalize(_, __, event: dict) -> dict:
    event.pop("_record", None)
    event.pop("_from_structlog", None)
    event.pop("color_message", None)
    event["msg"] = event.pop("event", "")
    return event


def configure(process: str) -> None:
    """Routes every logger to one JSON handler on stdout (called once per process: settings.py)."""
    level = _LEVELS.get(os.environ.get("LOG_LEVEL", "info"), logging.INFO)
    shared = [
        structlog.stdlib.add_log_level,
        _now,
        _context,
    ]
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[
            _record_fields,
            structlog.processors.format_exc_info,
            lambda _, __, e: {**e, "backend": "django", "process": process},
            _mask,
            _finalize,
            structlog.processors.JSONRenderer(ensure_ascii=False, default=str),
        ],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # uvicorn.access is left as uvicorn set it (`--no-access-log`: silenced; AccessLogMiddleware logs requests).
    for name in ("django", "django.request", "django.server", "uvicorn", "uvicorn.error", "celery"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    # Django's `log_response` (every response >= 400: "Unauthorized: /path", with the request, whose repr holds the
    # query string) is silenced: the access log (path only, R88 M1) and render_exception already record every outcome
    # once, as Express does (backend-express/src/http/access-log.ts).
    logging.getLogger("django.request").setLevel(logging.CRITICAL + 1)
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def get(name: str = "agrotrace"):
    return structlog.get_logger(name)
