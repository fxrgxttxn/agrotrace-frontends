"""
GET /events/stream (streamEvents; contracts/openapi/paths/events.yaml, R33) — an async Django view on the uvicorn event
loop, the port of the route in backend-express/src/modules/notifications/routes.ts.

Order: the `access_token` query parameter (EventSource cannot send headers; the `Authorization` header is not used) —
an invalid, expired or missing token → 401 problem before any stream; then the `user` rate limit (R30; Redis, on a
worker thread — nothing blocking runs in the loop) — x-roles ANY; then the headers (`text/event-stream`, `Cache-Control:
no-cache`, `X-Accel-Buffering: no` — the gateway must not buffer) and the stream: registration in the hub (live events
are buffered) → replay (`seq > L` + the 60 s window) → flush → `unread`; `ping` every 25 s; `reauth` at the token's
`exp`, then the end. `Last-Event-ID` wins over `lastEventId`; a value that is not a sequence number (`^\\d+$`, at most
18 digits) is treated as absent (the operation declares no 400).

The body starts with `retry: 3000` (PL8), then only `id:` / `event:` / `data:` frames, no comments. A client that
goes away cancels the response task: `asyncio.CancelledError` in the generator, whose `finally` takes the stream out of
the hub. No synchronous ORM call runs here (the reads are the SSE pool's, sse/dbpool.py).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from datetime import UTC, datetime

from asgiref.sync import sync_to_async
from django.http import StreamingHttpResponse

from agrotrace.core import ratelimit
from agrotrace.core.params import parse_query
from agrotrace.core.patterns import ecma
from agrotrace.core.problem import AppProblem, problem_response
from agrotrace.security.jwt import verify_access_token
from agrotrace.sse import hub as sse_hub
from agrotrace.sse.hub import ADMITTED_RETRY_MS, PING_S, Hub, Stream

log = logging.getLogger("agrotrace.sse")

SEQ = ecma(r"^\d{1,18}$")


def last_event_id(header: object, query: object) -> str | None:
    """`Last-Event-ID` wins over `lastEventId`; anything but 1…18 digits is absent."""
    raw = header if isinstance(header, str) else query if isinstance(query, str) else None
    return raw if raw is not None and SEQ.search(raw) else None


async def events(h: Hub, s: Stream, last_seq: str | None, *, ping_s: float = PING_S):
    """The response body: frames of `s` as the hub writes them, plus `ping` and `reauth`."""
    s.task = asyncio.current_task()
    if getattr(h, "stopped", False) or getattr(h, "stopped_streams", False):
        return  # the process is shutting down: the client reconnects elsewhere
    s.write(f"retry: {ADMITTED_RETRY_MS}\n\n")
    h.register(s)
    setup = asyncio.create_task(_connect(h, s, last_seq))
    next_ping = time.monotonic() + ping_s
    # The token's `exp` on the wall clock, mapped onto the monotonic one once.
    reauth_at = time.monotonic() + max(0, s.exp - time.time())
    try:
        while True:
            chunk = s.take()
            while chunk is not None:
                s.sending_since = time.monotonic()
                yield chunk
                s.sending_since = None
                chunk = s.take()
            if s.closed:
                return
            now = time.monotonic()
            if now >= reauth_at:
                s.reauth()
                continue
            if now >= next_ping:
                s.ping(datetime.now(UTC))
                next_ping += ping_s
                continue
            await s.wait(min(next_ping, reauth_at) - now)
    finally:
        setup.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await setup
        s.dispose()


async def _connect(h: Hub, s: Stream, last_seq: str | None) -> None:
    try:
        await h.connect_sequence(s, last_seq)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # The stream has started: no problem document can follow — log and end it (the client reconnects).
        log.error("sse stream setup failed", exc_info=e)
        s.end()


async def stream_events(request):
    query = parse_query(request.META.get("QUERY_STRING", ""))
    token = query.get("access_token")
    verified = verify_access_token(token) if isinstance(token, str) and token else None
    if verified is None:
        return problem_response(AppProblem(401, "UNAUTHORIZED"))
    principal, exp = verified
    try:
        await sync_to_async(ratelimit.hit, thread_sensitive=False)("user", principal.user_id)
    except AppProblem as p:
        return problem_response(p)
    h = sse_hub.hub()
    if h is None:
        raise RuntimeError("streamEvents: no SSE hub in this process")
    last_seq = last_event_id(request.META.get("HTTP_LAST_EVENT_ID"), query.get("lastEventId"))
    s = Stream(principal.user_id, exp)
    response = StreamingHttpResponse(events(h, s, last_seq), content_type="text/event-stream; charset=utf-8")
    response["Cache-Control"] = "no-cache"
    response["Connection"] = "keep-alive"
    response["X-Accel-Buffering"] = "no"
    return response
