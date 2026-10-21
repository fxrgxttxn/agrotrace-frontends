"""
Raw SQL on the current thread's Django connection (§7.6, §8.8: graphs, reports and bulk work are plain SQL with
placeholders). Placeholders are psycopg's `%s` / `%(name)s`; rows come back as dicts. Inside `with_tx` the statements
belong to its transaction.

Holder discipline (P61, the per-process holder rule): a thread holds a pool connection only AROUND its SQL, like
Express's per-query pool. A statement run outside a transaction gives the connection back to the pool right after it
(the next statement checks one out again), and `with_tx` gives it back after the commit/rollback. So CPU-heavy or
remote work between statements — Argon2, Pillow, MinIO, a Lane wait, DaData, SMTP — never holds one of the pool's
few connections. Work that must stay on ONE session across statements (a session advisory lock of a scheduler tick)
runs inside `pinned()`.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from django.db import connection

_pin = threading.local()


@contextmanager
def pinned() -> Iterator[None]:
    """Keeps this thread's connection checked out across statements (session state: advisory locks)."""
    _pin.depth = getattr(_pin, "depth", 0) + 1
    try:
        yield
    finally:
        _pin.depth -= 1


def is_pinned() -> bool:
    return getattr(_pin, "depth", 0) > 0


def _done() -> None:
    """After a statement: outside a transaction and unpinned, the connection goes back to the pool."""
    if not connection.in_atomic_block and not is_pinned():
        connection.close()


def holds_connection() -> bool:
    """True while this thread has a pool connection checked out (tests, guards)."""
    return connection.connection is not None


def execute(query: str, params: Any = None) -> int:
    """Runs one statement; the affected row count."""
    try:
        with connection.cursor() as cur:
            cur.execute(query, params)
            return cur.rowcount
    finally:
        _done()


def all(query: str, params: Any = None) -> list[dict[str, Any]]:  # noqa: A001
    try:
        with connection.cursor() as cur:
            cur.execute(query, params)
            if cur.description is None:
                return []
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
    finally:
        _done()


def one(query: str, params: Any = None) -> dict[str, Any] | None:
    rows = all(query, params)
    return rows[0] if rows else None


def scalar(query: str, params: Any = None) -> Any:
    try:
        with connection.cursor() as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return row[0] if row else None
    finally:
        _done()


def release() -> None:
    """Gives this thread's connection back to the pool now (before a long wait that needs no database). Calling it
    inside a transaction is a programmer's error — the wait would hold the transaction's connection (AssertionError)."""
    assert not connection.in_atomic_block, "sql.release() inside a transaction: the connection cannot be released"
    if not is_pinned():
        connection.close()


def jsonb(value: Any) -> Any:
    """A `jsonb` column as Python data: Django's psycopg setup loads jsonb as TEXT (for JSONField), `json` as data."""
    return json.loads(value) if isinstance(value, str) else value
