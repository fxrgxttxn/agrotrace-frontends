"""
The request pipeline in front of the routes, in the order of backend-express/src/app.ts (settings.MIDDLEWARE):

1. `RequestIdMiddleware` — outermost: `X-Request-Id` (R79: a client value matching `^[A-Za-z0-9._-]{1,64}$`, else a
   generated UUID) and `X-Backend: django` on EVERY response (errors and Swagger UI assets included); fills the
   request context (request id, client IP of the last X-Forwarded-For hop, P9);
2. (metrics — Task 14);
3. `AccessLogMiddleware` — one JSON line per finished request, the path without the query string (R88 M1);
4. `RawPathMiddleware` — the raw path (`scope['raw_path']`): an empty segment (`//`) anywhere, a malformed
   percent-escape or a non-UTF-8 escape → 404 NOT_FOUND (P8, contract-shape «malformed percent-escape»);
5. `MethodGuardMiddleware` — a contract path with a method the contract does not declare (OPTIONS included, HEAD
   counts as GET) → 405 METHOD_NOT_ALLOWED with the contract's `Allow`, implemented operation or not (P3); OPTIONS on
   any other path → 404;
6. `JsonBodyMiddleware` — JSON bodies (core.body) BEFORE routing, so a malformed body is 400 even on an operation
   that is not implemented yet;
then the `/api/v1` routes (urls.py) and the 404 problem (handler404).

The middlewares are async-capable: under ASGI only the view runs in a thread (ContractView).
"""

from __future__ import annotations

import ipaddress
import logging
import re
import time
import uuid
from urllib.parse import unquote_to_bytes

from asgiref.sync import iscoroutinefunction, markcoroutinefunction

from agrotrace.core import context
from agrotrace.core.body import is_json_type, read_json_body
from agrotrace.core.contract import contract_methods
from agrotrace.core.problem import AppProblem, problem_response

REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
BACKEND = "django"

access_log = logging.getLogger("agrotrace.access")


class _Middleware:
    """before(request) may answer early; after(request, response) post-processes; both modes, no thread hop."""

    sync_capable = True
    async_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        self.is_async = iscoroutinefunction(get_response)
        if self.is_async:
            markcoroutinefunction(self)

    def before(self, request):
        return None

    def after(self, request, response):
        return response

    def finish(self, request) -> None:
        """Runs after the response (or a failure), always."""

    def __call__(self, request):
        if self.is_async:
            return self._acall(request)
        try:
            early = self.before(request)
            response = early if early is not None else self.get_response(request)
            return self.after(request, response)
        finally:
            self.finish(request)

    async def _acall(self, request):
        try:
            early = self.before(request)
            response = early if early is not None else await self.get_response(request)
            return self.after(request, response)
        finally:
            self.finish(request)


def accept_request_id(value: str | None) -> str:
    return value if value is not None and REQUEST_ID_PATTERN.fullmatch(value) else str(uuid.uuid4())


def _ip(raw: str | None) -> str | None:
    if not raw:
        return None
    raw = raw.strip()
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return str(addr.ipv4_mapped)
    return raw


def client_ip(request) -> str | None:
    """Express `req.ip` with `trust proxy` = 1: the LAST X-Forwarded-For entry (the peer the gateway saw), else the
    socket peer; `::ffff:a.b.c.d` → `a.b.c.d`; a forwarded value that is not an IP literal → the socket peer."""
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    peer = request.META.get("REMOTE_ADDR")
    scope = getattr(request, "scope", None)
    if scope and scope.get("client"):
        peer = scope["client"][0]
    if xff is not None:
        last = xff.split(",")[-1]
        ip = _ip(last)
        if ip is not None:
            return ip
    return _ip(peer)


class RequestIdMiddleware(_Middleware):
    def before(self, request):
        rid = accept_request_id(request.META.get("HTTP_X_REQUEST_ID"))
        request.request_id = rid
        ctx = context.current()
        if ctx is None:
            ctx = context.RequestContext()
            request._agrotrace_ctx_token = context.bind(ctx)
        ctx.request_id = rid
        ctx.ip = client_ip(request)
        return None

    def after(self, request, response):
        response["X-Request-Id"] = request.request_id
        response["X-Backend"] = BACKEND
        # Like Express: a buffered answer states its length (Django sets none without CommonMiddleware).
        if not response.streaming and not response.has_header("Content-Length"):
            response["Content-Length"] = str(len(response.content))
        return response

    def finish(self, request):
        token = getattr(request, "_agrotrace_ctx_token", None)
        if token is not None:
            context.reset(token)


class AccessLogMiddleware(_Middleware):
    def before(self, request):
        request._agrotrace_started = time.perf_counter()
        return None

    def after(self, request, response):
        ms = (time.perf_counter() - request._agrotrace_started) * 1000
        path = request.path
        # Liveness probes (docker healthcheck every few seconds) only at debug level.
        level = logging.DEBUG if path == "/api/v1/health/live" and response.status_code == 200 else logging.INFO
        access_log.log(level, "request", extra={"method": request.method, "path": raw_path(request),
                                                "status": response.status_code, "ms": round(ms, 1)})
        return response


_BAD_ESCAPE = re.compile(rb"%(?![0-9A-Fa-f]{2})")


def raw_path_bytes(request) -> bytes:
    scope = getattr(request, "scope", None)
    raw = scope.get("raw_path") if scope else None
    if raw is None:
        return request.path.encode("utf-8")
    return raw.split(b"?", 1)[0]


def raw_path(request) -> str:
    return raw_path_bytes(request).decode("latin-1")


class RawPathMiddleware(_Middleware):
    def before(self, request):
        raw = raw_path_bytes(request)
        bad = b"//" in raw or _BAD_ESCAPE.search(raw) is not None
        if not bad:
            try:
                unquote_to_bytes(raw).decode("utf-8")
            except UnicodeDecodeError:
                bad = True
        return problem_response(AppProblem(404, "NOT_FOUND")) if bad else None


class MethodGuardMiddleware(_Middleware):
    def before(self, request):
        allow = contract_methods(raw_path(request))
        method = "GET" if request.method == "HEAD" else request.method
        if allow and method not in allow:
            return problem_response(AppProblem(405, "METHOD_NOT_ALLOWED", headers={"Allow": ", ".join(allow)}))
        if not allow and method == "OPTIONS":
            return problem_response(AppProblem(404, "NOT_FOUND"))
        return None


class JsonBodyMiddleware(_Middleware):
    def before(self, request):
        request.json_body = {}
        request.raw_body = b""
        if is_json_type(request.META.get("CONTENT_TYPE")):
            try:
                request.json_body, request.raw_body = read_json_body(request)
            except AppProblem as p:
                return problem_response(p)
        return None
