"""
Per-request context (contextvars, the port of backend-express/src/context.ts): the request id and the client IP follow
the request into the logger, the outbox (`envelope.requestId`) and the audit log (`request_id`, `ip`) without being
passed around. contextvars cross into the request's `sync_to_async` thread, so the synchronous DRF views see them.

D-I7: `client_gone()` — under Django's ASGI handler `http.disconnect` only cancels the async wrapper; the view's thread
keeps running. agrotrace/asgi.py wraps `receive` and sets the request's `gone` event on `http.disconnect`; long work
(Lane jobs, the report queue, SSE) polls it.
"""

from __future__ import annotations

import contextvars
import threading
from dataclasses import dataclass, field


@dataclass
class RequestContext:
    #: X-Request-Id of the request (audit `request_id`, outbox `requestId`); None outside a request.
    request_id: str | None = None
    #: Client IP as seen behind the gateway (last X-Forwarded-For hop, R30/P9); None if unknown.
    ip: str | None = None
    #: Set by the ASGI wrapper when the client disconnected (D-I7).
    gone: threading.Event = field(default_factory=threading.Event)
    #: Worker: the handled event's requestId — for log lines only.
    event_request_id: str | None = None


_ctx: contextvars.ContextVar[RequestContext | None] = contextvars.ContextVar("agrotrace_request", default=None)


def current() -> RequestContext | None:
    return _ctx.get()


def bind(ctx: RequestContext) -> contextvars.Token:
    return _ctx.set(ctx)


def reset(token: contextvars.Token) -> None:
    _ctx.reset(token)


def request_id() -> str | None:
    c = _ctx.get()
    return c.request_id if c else None


def client_ip() -> str | None:
    c = _ctx.get()
    return c.ip if c else None


def client_gone() -> bool:
    """True once the client of the current request disconnected (False outside a request)."""
    c = _ctx.get()
    return bool(c and c.gone.is_set())
