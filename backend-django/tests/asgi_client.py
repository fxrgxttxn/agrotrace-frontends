"""A minimal ASGI driver for the unit tests: one HTTP request against agrotrace.asgi.application, optionally with the
client going away (`http.disconnect`) after `disconnect_after` seconds."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Result:
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def json(self) -> Any:
        return json.loads(self.body)


async def call(method: str, path: str, *, headers: dict[str, str] | None = None, body: bytes = b"",
               disconnect_after: float | None = None, raw_path: bytes | None = None, app=None) -> Result:
    if app is None:
        from agrotrace.asgi import application as app
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path.split("?", 1)[0],
        "raw_path": raw_path if raw_path is not None else path.split("?", 1)[0].encode(),
        "query_string": path.split("?", 1)[1].encode() if "?" in path else b"",
        "root_path": "",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()],
        "client": ("10.0.0.9", 50000),
        "server": ("api-django", 8000),
    }
    sent = False
    out = Result()

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        if disconnect_after is not None:
            await asyncio.sleep(disconnect_after)
            return {"type": "http.disconnect"}
        await asyncio.Event().wait()

    async def send(message):
        if message["type"] == "http.response.start":
            out.status = message["status"]
            out.headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            out.body += message.get("body", b"")

    await app(scope, receive, send)
    return out


def run(coro):
    return asyncio.run(coro)
