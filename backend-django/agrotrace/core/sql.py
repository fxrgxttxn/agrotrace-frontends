"""
Raw SQL on the current thread's Django connection (§7.6, §8.8: graphs, reports and bulk work are plain SQL with
placeholders). Placeholders are psycopg's `%s` / `%(name)s`; rows come back as dicts. Inside `with_tx` the statements
belong to its transaction.
"""

from __future__ import annotations

from typing import Any

from django.db import connection


def execute(query: str, params: Any = None) -> int:
    """Runs one statement; the affected row count."""
    with connection.cursor() as cur:
        cur.execute(query, params)
        return cur.rowcount


def all(query: str, params: Any = None) -> list[dict[str, Any]]:  # noqa: A001
    with connection.cursor() as cur:
        cur.execute(query, params)
        if cur.description is None:
            return []
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]


def one(query: str, params: Any = None) -> dict[str, Any] | None:
    rows = all(query, params)
    return rows[0] if rows else None


def scalar(query: str, params: Any = None) -> Any:
    with connection.cursor() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        return row[0] if row else None
