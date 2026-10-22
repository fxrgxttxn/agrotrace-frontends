"""
Outbox relay and sweeper, publishing side (R55, R56, contracts/events/envelope.schema.json), the port of
backend-express/src/infra/relay.ts on Celery (plan 3, «Очередь, воркер и планировщик»): a row of `outbox_events`
(`backend = 'django'`) is published as the Celery task named by its `type` with the envelope as the single argument —
`app.send_task(type, args=[envelope], task_id=id, exchange='agrotrace.django', routing_key=type, delivery_mode=2,
retry=False)` on a publisher-confirm connection (10 s confirm timeout) — then marked: `UPDATE … SET published_at = now(),
attempts = attempts + 1 WHERE id = :id AND published_at IS NULL`. A crash or a failed confirm between the two steps only
causes a re-publish (consumers dedupe by the event id, R56); a row whose publish failed stays for the sweeper.

- `publish(ids)` — the fast path, right after the causing transaction committed and released its connection
  (`Tx.after_release`): it reads the rows (skipping those a sweeper pass holds locked), publishes and marks them, each
  statement on its own short checkout — no pool connection is held while the broker confirms (P61);
- `publish_rows(rows, mark)` — shared with the beat's sweeper (scheduler/jobs/outbox_sweeper.py), which holds its rows
  `FOR NO KEY UPDATE SKIP LOCKED` on its own connection.

Every event type of the envelope is published (Express limited it to `vsd.import` only until its Task 12).
Business code never publishes: only this module and events.tasks (the delay copy) touch the broker.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import Any

from agrotrace.core import sql

log = logging.getLogger("agrotrace.relay")

EXCHANGE = "agrotrace.django"
CONFIRM_TIMEOUT_S = 10.0
MARK = "UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = %s AND published_at IS NULL"
SELECT = ("SELECT id::text AS id, type, payload FROM outbox_events "
          "WHERE backend = 'django' AND published_at IS NULL")


def send(producer: Any, row: dict[str, Any]) -> None:
    """One row → one confirmed Celery message (raises when the broker refuses or does not confirm in time)."""
    from agrotrace.celery_app import app

    app.send_task(row["type"], args=[sql.jsonb(row["payload"])], task_id=row["id"], exchange=EXCHANGE,
                  routing_key=row["type"], delivery_mode=2, retry=False, confirm_timeout=CONFIRM_TIMEOUT_S,
                  producer=producer)


def publish_rows(rows: Sequence[dict[str, Any]], mark: Callable[[str, list[Any]], Any] = sql.execute) -> int:
    """Publishes `rows` in order and marks each one after its confirm; stops at the first failure (the rest wait for
    the sweeper). Returns how many were published."""
    if not rows:
        return 0
    from agrotrace.celery_app import app

    done = 0
    with app.producer_or_acquire() as producer:
        for row in rows:
            try:
                send(producer, row)
            except Exception as e:
                log.warning("outbox publish failed; the sweeper retries",
                            extra={"err": str(e), "eventId": row["id"], "type": row["type"]})
                try:
                    producer.connection.collect()  # a fresh connection for the next publish
                except Exception:  # noqa: S110 - best effort
                    pass
                break
            mark(MARK, [row["id"]])
            done += 1
    return done


def publish(event_ids: Sequence[str]) -> None:
    """Publishes these rows now (their transaction has committed); never raises — the sweeper retries."""
    ids = [str(i) for i in event_ids]
    if not ids:
        return
    try:
        # SKIP LOCKED: a row a sweeper pass is publishing right now is left to it (the lock ends with the statement).
        rows = sql.all(SELECT + " AND id = ANY(%s::uuid[]) ORDER BY created_at FOR NO KEY UPDATE SKIP LOCKED", [ids])
        publish_rows(rows)
    except Exception as e:
        log.warning("outbox relay failed; the sweeper retries", extra={"err": str(e), "ids": ids})
