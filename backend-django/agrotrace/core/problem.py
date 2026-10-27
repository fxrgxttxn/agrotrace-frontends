"""
RFC 7807 problems (contract `Problem`, info.description), the port of backend-express/src/http/problem.ts. Every
error path ends here: `application/problem+json`, `type` = `/problems/<kebab-case code>`, `title`, `status`, `code`
and the optional `detail`/`rule`/`params`/`errors`. Django's and DRF's own error output (HTML 400/404/500 pages,
`{"detail": …}`, 403 instead of 401, 406/415 negotiation) never reaches a client: DRF's EXCEPTION_HANDLER and
Django's handler400/403/404/500 all render through `problem_response`. Unknown errors become 500 INTERNAL without
any internals in the body; they are logged with the request id.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Mapping
from typing import Any

from django.http import HttpResponse

from agrotrace.core.render import json_bytes

log = logging.getLogger("agrotrace.problem")

#: contracts/openapi/schemas/common.yaml#/ProblemCode → default title (for logs; clients never rely on it).
TITLES: dict[str, str] = {
    "VALIDATION": "Validation failed",
    "UNAUTHORIZED": "Unauthorized",
    "FORBIDDEN": "Forbidden",
    "NOT_FOUND": "Not found",
    "INVALID_TRANSITION": "Invalid status transition",
    "VERSION_CONFLICT": "Version conflict",
    "BUSINESS_RULE": "Business rule violated",
    "FILE_TOO_LARGE": "File too large",
    "UNSUPPORTED_MEDIA_TYPE": "Unsupported media type",
    "RATE_LIMITED": "Too many requests",
    "ACCOUNT_LOCKED": "Account locked",
    "INVALID_CREDENTIALS": "Invalid credentials",
    "TWO_FACTOR_REQUIRED": "Two-factor authentication required",
    "INVALID_TWO_FACTOR_CODE": "Invalid two-factor code",
    "TOKEN_EXPIRED": "Token expired",
    "IDEMPOTENCY_KEY_REUSED": "Idempotency key reused",
    "INVALID_IDEMPOTENCY_KEY": "Invalid idempotency key",
    "CAPTCHA_FAILED": "Captcha failed",
    "GRAPH_CYCLE": "Graph cycle",
    "BACKEND_UNAVAILABLE": "Backend unavailable",
    "EXTERNAL_UNAVAILABLE": "External service unavailable",
    "INTERNAL": "Internal server error",
    "NO_LAB_AVAILABLE": "No laboratory available",
    "IDEMPOTENCY_KEY_IN_PROGRESS": "Idempotency key in progress",
    "REFERENCE_IN_USE": "Reference in use",
    "METHOD_NOT_ALLOWED": "Method not allowed",
}

#: JSON body limit — the gateway's client_max_body_size (12 MiB, R34/R79).
JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024

#: As Express (`res.type("application/problem+json")` adds the charset): `application/problem+json; charset=utf-8`.
PROBLEM_MEDIA_TYPE = "application/problem+json; charset=utf-8"


def problem_type(code: str) -> str:
    """`VERSION_CONFLICT` → `/problems/version-conflict`."""
    return "/problems/" + code.lower().replace("_", "-")


class AppProblem(Exception):
    """A problem raised anywhere in a request; the handlers render it as is."""

    def __init__(
        self,
        status: int,
        code: str,
        *,
        rule: str | None = None,
        params: Mapping[str, Any] | None = None,
        errors: Mapping[str, list[str]] | None = None,
        headers: Mapping[str, str] | None = None,
        title: str | None = None,
        detail: str | None = None,
    ):
        if code not in TITLES:
            raise ValueError(f"unknown ProblemCode {code}")
        self.status = status
        self.code = code
        self.rule = rule
        self.params = dict(params) if params is not None else None
        self.errors = {k: list(v) for k, v in errors.items()} if errors is not None else None
        self.headers = dict(headers or {})
        self.title = title or TITLES[code]
        self.detail = detail
        super().__init__(self.title)

    def body(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": problem_type(self.code), "title": self.title, "status": self.status,
                               "code": self.code}
        if self.detail is not None:
            out["detail"] = self.detail
        if self.rule is not None:
            out["rule"] = self.rule
        if self.params is not None:
            out["params"] = self.params
        if self.errors is not None:
            out["errors"] = self.errors
        return out


def validation_problem(errors: Mapping[str, list[str]]) -> AppProblem:
    """400 VALIDATION with field errors (`Problem.errors`: path → i18n keys)."""
    return AppProblem(400, "VALIDATION", errors=errors)


def root_invalid() -> AppProblem:
    """A body that cannot be read as JSON: the error sits at the body root (P7)."""
    return validation_problem({"_root": ["validation.invalid"]})


def too_large() -> AppProblem:
    return AppProblem(413, "FILE_TOO_LARGE", params={"maxBytes": JSON_BODY_LIMIT_BYTES})


def problem_response(problem: AppProblem) -> HttpResponse:
    res = HttpResponse(json_bytes(problem.body()), status=problem.status, content_type=PROBLEM_MEDIA_TYPE)
    for k, v in problem.headers.items():
        res[k] = v
    return res


# ── mapping of everything else ────────────────────────────────────────────────────────────────────────────────────

_UNAVAILABLE_SQLSTATES = {"57014", "55P03"}  # statement_timeout, lock_timeout (P61)


def _chain(exc: BaseException):
    seen: set[int] = set()
    e: BaseException | None = exc
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        yield e
        e = e.__cause__ or e.__context__


def sqlstate(exc: BaseException) -> str | None:
    """The PostgreSQL SQLSTATE of a (Django-wrapped) psycopg error, or None."""
    for e in _chain(exc):
        state = getattr(e, "sqlstate", None)
        if isinstance(state, str):
            return state
    return None


def is_backend_unavailable(exc: BaseException) -> bool:
    """P61: no pool connection in time (PoolTimeout), or statement/lock waits past their session timeouts."""
    try:
        from psycopg_pool import PoolTimeout
    except ImportError:  # pragma: no cover
        PoolTimeout = ()  # type: ignore[assignment]  # noqa: N806
    for e in _chain(exc):
        if PoolTimeout and isinstance(e, PoolTimeout):
            return True
    return sqlstate(exc) in _UNAVAILABLE_SQLSTATES


def to_problem(exc: BaseException) -> AppProblem | None:
    """Any raised value → the problem the client gets; None = unexpected (500 INTERNAL)."""
    from rest_framework import exceptions as drf

    if isinstance(exc, AppProblem):
        return exc
    if isinstance(exc, (drf.NotAuthenticated, drf.AuthenticationFailed)):
        return AppProblem(401, "UNAUTHORIZED")
    if isinstance(exc, drf.PermissionDenied):
        return AppProblem(403, "FORBIDDEN")
    if isinstance(exc, drf.NotFound):
        return AppProblem(404, "NOT_FOUND")
    if isinstance(exc, drf.ParseError):
        return root_invalid()
    if isinstance(exc, drf.UnsupportedMediaType):
        return AppProblem(415, "UNSUPPORTED_MEDIA_TYPE", params={"allowed": ["application/json"]})
    if isinstance(exc, drf.Throttled):
        return AppProblem(429, "RATE_LIMITED")
    if isinstance(exc, drf.MethodNotAllowed):
        # The method guard answers undeclared methods first; this is only a safety net (no Allow known here).
        return AppProblem(404, "NOT_FOUND")
    if isinstance(exc, drf.ValidationError):
        return root_invalid()
    from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
    from django.core.exceptions import RequestDataTooBig, SuspiciousOperation
    from django.http import Http404

    if isinstance(exc, Http404):
        return AppProblem(404, "NOT_FOUND")
    if isinstance(exc, RequestDataTooBig):
        return too_large()
    if isinstance(exc, SuspiciousOperation):
        return root_invalid()
    if isinstance(exc, DjangoPermissionDenied):
        return AppProblem(403, "FORBIDDEN")
    if is_backend_unavailable(exc):
        return AppProblem(503, "BACKEND_UNAVAILABLE")
    return None


def render_exception(exc: BaseException, request=None) -> HttpResponse:
    problem = to_problem(exc)
    from agrotrace.core import context

    extra = {"requestId": context.request_id(), "path": getattr(request, "path", None),
             "method": getattr(request, "method", None)}
    if problem is None:
        log.error("unhandled error", exc_info=exc, extra=extra)
        problem = AppProblem(500, "INTERNAL")
    elif problem.status >= 500:
        log.error("request failed", exc_info=exc, extra=extra)
    return problem_response(problem)


def exception_handler(exc: Exception, context: dict) -> HttpResponse:
    """DRF `EXCEPTION_HANDLER`: every exception of a view (DRF's included) → a contract problem."""
    return render_exception(exc, context.get("request"))


# ── Django's handlers (urls.py handler400/403/404/500) ────────────────────────────────────────────────────────────

def handler400(request, exception=None):
    return render_exception(exception or root_invalid(), request)


def handler403(request, exception=None):
    return problem_response(AppProblem(403, "FORBIDDEN"))


def handler404(request, exception=None):
    return problem_response(AppProblem(404, "NOT_FOUND"))


def handler500(request):
    # Called by Django inside its `except` for an error outside DRF (a plain async view such as the SSE stream, a
    # middleware, a failed render). django.request is silenced (core/logging.py), so the error is logged here, once,
    # as render_exception logs DRF's: path only, never the query, with its traceback (Express's error handler).
    exc = sys.exc_info()[1]
    if exc is None:
        log.error("unhandled error", extra={"path": getattr(request, "path", None),
                                            "method": getattr(request, "method", None)})
        return problem_response(AppProblem(500, "INTERNAL"))
    return render_exception(exc, request)
