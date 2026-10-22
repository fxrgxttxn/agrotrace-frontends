"""
Outbox relay and sweeper, publishing side (R55, R56, contracts/events/envelope.schema.json), the port of
backend-express/src/infra/relay.ts on Celery (plan 3, «Очередь, воркер и планировщик»; Rulings Q12, Q13 revised).

A row of `outbox_events` (`backend = 'django'`) is published as the Celery task named by its `type` with the envelope
as the single argument — `app.send_task(type, args=[envelope], task_id=id, exchange='agrotrace.django', routing_key=
type, delivery_mode=2, retry=False)` on a publisher-confirm connection — then marked: `UPDATE … SET published_at =
now(), attempts = attempts + 1 WHERE id = :id AND published_at IS NULL`. As in Express, the rows are picked
`FOR NO KEY UPDATE SKIP LOCKED` inside ONE transaction that stays open across send + confirm + mark (the broker channel is
opened BEFORE that transaction, as Express opens its confirm channel first: a reconnect holds no row lock): a sweeper pass
skips a row in flight, so the same row is sent again only after a failed attempt (R56: consumers dedupe).

- Only the types with a handler in worker-django are published (`events.handlers.HANDLED_TYPES`, Ruling Q12); rows of
  other types stay unpublished until their task registers the handler.
- `publish(ids)` — the fast path, never on the request path: it hands the ids to this process's relay thread and
  returns at once (called from `Tx.after_release`, after the commit). The thread holds at most ONE pool connection,
  and only while a batch is in flight (the api budget, P61). While the broker is unreachable (fail-fast connect and
  confirm timeouts, then a back-off from 1 s doubling to 30 s) the thread drops what it is given: the sweeper is the
  guarantee.
- `sweep_rows(tx, limit)` — the beat's outbox-sweeper pass (scheduler/jobs/outbox_sweeper.py), on the job's own
  connection.
- The beat process has no relay thread: events of scheduler jobs are left to the sweeper (as in Express).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any

from agrotrace.core import sql
from agrotrace.events.handlers import HANDLED_TYPES

log = logging.getLogger("agrotrace.relay")

EXCHANGE = "agrotrace.django"
CONFIRM_TIMEOUT_S = 5.0
BACKOFF_MIN_S = 1.0
BACKOFF_MAX_S = 30.0
MARK = "UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = %s AND published_at IS NULL"
SELECT = ("SELECT id::text AS id, type, payload FROM outbox_events "
          "WHERE backend = 'django' AND published_at IS NULL AND type = ANY(%s)")


def handled_types() -> list[str]:
    return list(HANDLED_TYPES)


def send(producer: Any, row: dict[str, Any]) -> None:
    """One row → one confirmed Celery message (raises when the broker refuses or does not confirm in time)."""
    from agrotrace.celery_app import app

    app.send_task(row["type"], args=[sql.jsonb(row["payload"])], task_id=row["id"], exchange=EXCHANGE,
                  routing_key=row["type"], delivery_mode=2, retry=False, confirm_timeout=CONFIRM_TIMEOUT_S,
                  producer=producer)


@contextmanager
def connected_producer() -> Iterator[Any | None]:
    """A producer whose broker connection and confirm channel are open BEFORE the caller opens its transaction (Express
    `publishLocked`: `confirmChannel()` first): a reconnect — up to the 2 s connect timeout — never holds a pool
    connection or row locks. Yields None when the broker cannot be reached (the caller publishes nothing)."""
    from agrotrace.celery_app import app

    with app.producer_or_acquire() as producer:
        try:
            _ = producer.channel  # kombu: connects (fail-fast transport options) and opens the channel
        except Exception as e:
            log.warning("broker unreachable; the sweeper retries", extra={"err": str(e)})
            _collect(producer)
            producer = None
        yield producer


def _collect(producer: Any) -> None:
    try:
        producer.connection.collect()  # a fresh connection for the next publish
    except Exception:  # noqa: S110 - best effort
        pass


def publish_rows(rows: Sequence[dict[str, Any]], producer: Any | None,
                 mark: Callable[[str, list[Any]], Any] = sql.execute) -> tuple[int, bool]:
    """Publishes the (locked) `rows` in order on the already connected `producer` and marks each one after its
    confirm; stops at the first failure (the rest wait for the sweeper). Returns (how many were published, whether a
    publish failed); no producer (broker down) → nothing published, failed."""
    if not rows:
        return 0, False
    if producer is None:
        return 0, True
    done = 0
    for row in rows:
        try:
            send(producer, row)
        except Exception as e:
            log.warning("outbox publish failed; the sweeper retries",
                        extra={"err": str(e), "eventId": row["id"], "type": row["type"]})
            _collect(producer)
            return done, True
        mark(MARK, [row["id"]])
        done += 1
    return done, False


def flush(ids: Sequence[str]) -> tuple[int, bool]:
    """Publishes these rows now, in one transaction holding them FOR NO KEY UPDATE SKIP LOCKED across send + confirm
    (a row a sweeper pass holds is left to it). The broker channel is opened first, outside the transaction. The relay
    thread's work; tests call it directly."""
    from agrotrace.core.tx import with_tx

    wanted = [str(i) for i in ids]
    if not wanted:
        return 0, False

    with connected_producer() as producer:
        if producer is None:
            return 0, True

        def run(tx):
            rows = tx.all(SELECT + " AND id = ANY(%s::uuid[]) ORDER BY created_at FOR NO KEY UPDATE SKIP LOCKED",
                          [handled_types(), wanted])
            return publish_rows(rows, producer, mark=tx.execute)

        return with_tx(run, retry_once=False)


def sweep_rows(tx, limit: int, producer: Any | None) -> tuple[int, bool]:
    """The sweeper's pick: the oldest unpublished rows of the handled types, locked SKIP LOCKED in `tx`, published on
    the `producer` the sweeper connected before opening `tx` (None: the broker is down — nothing is picked)."""
    if producer is None:
        return 0, True
    rows = tx.all(SELECT + " ORDER BY created_at LIMIT %s FOR NO KEY UPDATE SKIP LOCKED", [handled_types(), limit])
    return publish_rows(rows, producer, mark=tx.execute)


class Relay:
    """The per-process relay thread: ids in, one batch at a time out; it never blocks its callers."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._pending: list[str] = []
        self._busy = False
        self._thread: threading.Thread | None = None
        self._down_until = 0.0
        self._backoff = BACKOFF_MIN_S

    def submit(self, ids: Sequence[str]) -> None:
        with self._cv:
            self._pending.extend(str(i) for i in ids)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="outbox-relay", daemon=True)
                self._thread.start()
            self._cv.notify()

    def wait_idle(self, timeout: float = 10.0) -> bool:
        """True once nothing is pending or in flight (tests, shutdown)."""
        deadline = time.monotonic() + timeout
        with self._cv:
            while self._pending or self._busy:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._cv.wait(left)
            return True

    def broker_down(self) -> bool:
        return time.monotonic() < self._down_until

    def _loop(self) -> None:
        from django.db import connections

        while True:
            with self._cv:
                while not self._pending:
                    self._cv.wait()
                batch, self._pending = self._pending, []
                self._busy = True
            try:
                if self.broker_down():
                    log.info("broker down; the sweeper publishes these", extra={"ids": batch})
                    continue
                _done, failed = flush(batch)
                if failed:
                    self._down_until = time.monotonic() + self._backoff
                    self._backoff = min(self._backoff * 2, BACKOFF_MAX_S)
                else:
                    self._backoff = BACKOFF_MIN_S
            except Exception as e:
                log.warning("outbox relay failed; the sweeper retries", extra={"err": str(e), "ids": batch})
            finally:
                connections.close_all()
                with self._cv:
                    self._busy = False
                    self._cv.notify_all()


_relay = Relay()


def relay() -> Relay:
    return _relay


def enabled() -> bool:
    """No relay thread in beat: its jobs' events are left to the sweeper it runs anyway (as in Express)."""
    return os.environ.get("AGROTRACE_PROCESS", "api") != "beat"


def publish(event_ids: Sequence[str]) -> None:
    """Hands these committed rows to the relay thread; returns at once and never raises."""
    ids = [str(i) for i in event_ids]
    if ids and enabled():
        _relay.submit(ids)
