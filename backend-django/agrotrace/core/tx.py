"""
Transactions (R47/R52), the port of backend-express/src/db/tx.ts. READ COMMITTED by default, REPEATABLE READ for the
recall engine (`RECALL_TX`, D-I3). A deadlock (40P01) or serialization failure (40001) — and anything `retry_if`
accepts — re-runs the whole transaction ONCE; a second failure is 409 VERSION_CONFLICT (`params` from
`conflict_params`, read outside the failed transaction).

Contract for `fn` (P8): it may run TWICE, so it touches only the database through `tx` — no Redis, no S3, no
publishing, no mail, no in-memory state that survives a failed attempt. What must follow the commit goes to the outbox
(`infra.outbox.enqueue`) or to `tx.on_commit(cb)` (dropped with a rolled-back attempt). `with_tx` inside an open
`atomic` is a programmer's error (a savepoint can neither set the isolation level nor be retried): AssertionError.

P43: `tx.now` is the transaction's `now()` (read once, the same instant for every statement and for the
`touch_updated_at` triggers of the transaction).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal

from django.db import connection, transaction

from agrotrace.core import sql
from agrotrace.core.problem import AppProblem, sqlstate

log = logging.getLogger("agrotrace.tx")

Isolation = Literal["read committed", "repeatable read", "read only repeatable read"]

_SET_ISOLATION: dict[str, str | None] = {
    "read committed": None,  # PostgreSQL's default; nothing to set
    "repeatable read": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "read only repeatable read": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
}
RETRYABLE = frozenset({"40P01", "40001"})


class Tx:
    """The open transaction of one `with_tx` attempt."""

    def __init__(self) -> None:
        self._now: datetime | None = None
        self._after: list[Callable[[], Any]] = []

    @property
    def now(self) -> datetime:
        """The transaction's `now()` (one read per transaction)."""
        if self._now is None:
            self._now = sql.scalar("SELECT now()")
        return self._now

    def on_commit(self, cb: Callable[[], Any]) -> None:
        """Runs `cb` after this attempt commits; never after a rollback (a retried attempt drops it)."""
        transaction.on_commit(cb)

    def after_release(self, cb: Callable[[], Any]) -> None:
        """Runs `cb` after this attempt committed AND the connection went back to the pool (P61): work that talks to
        another service (the outbox relay publishing to RabbitMQ) holds no pool connection. Never after a rollback;
        an exception of `cb` is logged, never raised (the transaction is already committed)."""
        self._after.append(cb)

    # Thin helpers over core.sql (the connection of the current thread is the transaction's).
    def execute(self, query: str, params: Any = None) -> int:
        return sql.execute(query, params)

    def all(self, query: str, params: Any = None) -> list[dict[str, Any]]:
        return sql.all(query, params)

    def one(self, query: str, params: Any = None) -> dict[str, Any] | None:
        return sql.one(query, params)

    def scalar(self, query: str, params: Any = None) -> Any:
        return sql.scalar(query, params)


def is_retryable(exc: BaseException) -> bool:
    return sqlstate(exc) in RETRYABLE


def is_unique_violation(constraint: str) -> Callable[[BaseException], bool]:
    """23505 on the named constraint/index (`exc.__cause__.diag.constraint_name`)."""

    def check(exc: BaseException) -> bool:
        e: BaseException | None = exc
        while e is not None:
            if getattr(e, "sqlstate", None) == "23505":
                diag = getattr(e, "diag", None)
                return getattr(diag, "constraint_name", None) == constraint
            e = e.__cause__
        return False

    return check


def with_tx[T](
    fn: Callable[[Tx], T],
    *,
    isolation: Isolation = "read committed",
    retry_once: bool = True,
    retry_if: Callable[[Exception], bool] | None = None,
    conflict_params: Callable[[], dict] | None = None,
) -> T:
    assert not connection.in_atomic_block, "with_tx() inside an open transaction (atomic) is not allowed"
    attempts = 2 if retry_once else 1
    attempt = 0
    committed: Tx | None = None
    try:
        while True:
            attempt += 1
            try:
                tx = Tx()
                with transaction.atomic():
                    stmt = _SET_ISOLATION[isolation]
                    if stmt:
                        sql.execute(stmt)
                    result = fn(tx)
                committed = tx
                break
            except AppProblem:
                raise
            except Exception as exc:
                if not is_retryable(exc) and not (retry_if is not None and retry_if(exc)):
                    raise
                if attempt < attempts:
                    continue
                params = conflict_params() if conflict_params else None
                raise AppProblem(409, "VERSION_CONFLICT", params=params) from exc
    finally:
        # P61 holder discipline (core.sql): the connection goes back to the pool once the transaction is over.
        if not sql.is_pinned() and not connection.in_atomic_block:
            connection.close()
    for cb in committed._after:  # type: ignore[union-attr]  # set by the break
        try:
            cb()
        except Exception as e:
            log.warning("after-release callback failed", exc_info=e)
    return result


#: Every entry of the recall engine (Tasks 9–11, D-I3): REPEATABLE READ and one more attempt when a parallel start
#: by the same source won the race (the repeat finds the open recall the other one created).
RECALL_TX: dict[str, Any] = dict(isolation="repeatable read", retry_if=is_unique_violation("ux_recalls_open_source"))
