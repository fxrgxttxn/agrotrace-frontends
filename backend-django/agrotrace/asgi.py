"""
The api process: `uvicorn agrotrace.asgi:application --workers 1` (one process, P61 as revised by SP4).

`application` wraps Django's ASGI handler:
- `lifespan` (Django does not handle it): at start-up the configuration is checked (settings already loaded it — a bad
  value never gets this far) and the process-wide services start (the SSE hub with its LISTEN session — Task 12, the
  metrics server on METRICS_PORT — Task 14); at shutdown the hub closes first;
- every `http` request gets its RequestContext (core.context) and a wrapped `receive`: `http.disconnect` sets the
  request's `gone` event, which `core.context.client_gone()` reads from the view's thread (D-I7) — Django's handler
  only cancels its async wrapper, the synchronous view keeps running.
Synchronous DRF views run each in its own thread (Django's ThreadSensitiveContext per request), so parallel requests
really run in parallel.
"""

from __future__ import annotations

import logging
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agrotrace.settings")

from django.core.asgi import get_asgi_application  # noqa: E402

from agrotrace.core import context  # noqa: E402
from agrotrace.sse import hub as sse_hub  # noqa: E402

django_application = get_asgi_application()
log = logging.getLogger("agrotrace.asgi")

#: Callables run at lifespan start-up / shutdown: the SSE hub (its LISTEN session exists from the start, as in Express;
#: it closes first at shutdown), later the metrics server (Task 14).
STARTUP: list = [sse_hub.start]
SHUTDOWN: list = [sse_hub.close]


async def _lifespan(receive, send) -> None:
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            try:
                from agrotrace.core import config

                config.get()
                for fn in STARTUP:
                    await fn()
            except Exception as e:  # pragma: no cover - start-up failure stops the process
                log.error("start-up failed", exc_info=e)
                await send({"type": "lifespan.startup.failed", "message": str(e)})
                return
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            for fn in SHUTDOWN:
                try:
                    await fn()
                except Exception as e:  # pragma: no cover
                    log.warning("shutdown step failed", exc_info=e)
            await send({"type": "lifespan.shutdown.complete"})
            return


async def application(scope, receive, send):
    if scope["type"] == "lifespan":
        await _lifespan(receive, send)
        return
    if scope["type"] != "http":
        return await django_application(scope, receive, send)
    ctx = context.RequestContext()
    token = context.bind(ctx)

    async def tracked_receive():
        message = await receive()
        if message["type"] == "http.disconnect":
            ctx.gone.set()
        return message

    try:
        await django_application(scope, tracked_receive, send)
    finally:
        context.reset(token)
