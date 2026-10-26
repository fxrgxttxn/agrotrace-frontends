"""
The SSE side's own asynchronous pool (P61 as revised by SP4: api `DJANGO_SSE_POOL_MAX` = 2, D-I5). Every database read
of the SSE hub (a notification row, the unread count, a resync's catch-up) and of a connecting stream (watermark,
replay, unread) runs here, in the event loop of the api process — never through Django's synchronous ORM (a
SynchronousOnlyOperation, or a blocked loop). Autocommit sessions of the application role (APP_DATABASE_URL, D-I8)
with the same session settings as Django's pool (UTC, statement_timeout, lock_timeout); a connection is checked
before it is handed out (it survives `./at reset` from another worktree) and a wait for a free one is bounded by
DB_CONNECT_TIMEOUT_MS.

The LISTEN session is NOT from this pool (sse/hub.py: one dedicated connection, the third holder of the api's 10).
"""

from __future__ import annotations

import os
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from agrotrace.core import config

APPLICATION_NAME = "agrotrace-django-api-sse"


def conninfo() -> str:
    """The test suite points the SSE side at its own database, like the Django alias (settings.py)."""
    return os.environ.get("TEST_DATABASE_URL") or config.get().APP_DATABASE_URL


def session_options() -> str:
    c = config.get()
    return (f"-c TimeZone=UTC -c statement_timeout={c.DB_STATEMENT_TIMEOUT_MS} "
            f"-c lock_timeout={c.DB_LOCK_TIMEOUT_MS}")


class SsePool:
    def __init__(self, max_size: int | None = None) -> None:
        c = config.get()
        self.pool = AsyncConnectionPool(
            conninfo(), min_size=0, max_size=max_size or c.DJANGO_SSE_POOL_MAX,
            timeout=c.DB_CONNECT_TIMEOUT_MS / 1000, open=False, name="django-api-sse",
            check=AsyncConnectionPool.check_connection,
            kwargs={"autocommit": True, "row_factory": dict_row, "application_name": APPLICATION_NAME,
                    "options": session_options()})

    async def open(self) -> None:
        await self.pool.open(wait=False)

    async def close(self) -> None:
        await self.pool.close()

    async def all(self, query: str, params: Any = None) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(query, params)
            return await cur.fetchall() if cur.description is not None else []

    async def one(self, query: str, params: Any = None) -> dict[str, Any] | None:
        rows = await self.all(query, params)
        return rows[0] if rows else None

    async def scalar(self, query: str, params: Any = None) -> Any:
        row = await self.one(query, params)
        return next(iter(row.values())) if row else None
