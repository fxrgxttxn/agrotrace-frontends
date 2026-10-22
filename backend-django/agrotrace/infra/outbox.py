"""
Transactional outbox, write side (R55, R56, P1), the port of backend-express/src/infra/outbox.ts: an event is a row of
`outbox_events` (`backend = 'django'`) inserted in the SAME transaction as the state change that causes it; its
`payload` is the whole queue document of contracts/events/envelope.schema.json (`id` = outbox_events.id = the Celery
task_id). `occurredAt` is the clock time of the INSERT (R59), `requestId` the current request's (or the one given).

Publishing is never done here: after the transaction committed and its connection went back to the pool
(`Tx.after_release`, P61), the ids go to the process's relay thread (`infra.relay.publish`, the fast path — the
request never waits on the broker), and the beat's outbox sweeper (every 5 s) is the guarantee.
A rolled-back attempt (e.g. the first try of a 40P01 retry) drops its callback and its row: nothing is published.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from agrotrace.core import context
from agrotrace.core.render import iso, json_dumps
from agrotrace.core.tx import Tx

log = logging.getLogger("agrotrace.outbox")

#: contracts/events/envelope.schema.json#/properties/type/enum
EVENT_TYPES = ("recall.requested", "notification.dispatch", "lab.escalate", "rating.recalculate", "vsd.import")

_UNSET: Any = object()


def _relay_after_commit(ids: list[str]) -> None:
    """The fast path: publish right after commit, in the same thread, holding no pool connection (the relay's own
    statements check one out each). A failure never fails the committed request: the sweeper publishes the rows."""
    from agrotrace.infra import relay

    try:
        relay.publish(ids)
    except Exception as e:
        log.warning("outbox relay failed; the sweeper retries", extra={"err": str(e), "ids": ids})


def enqueue(tx: Tx, type: str, data: dict[str, Any], *, request_id: str | None = _UNSET) -> str:  # noqa: A002
    """Writes the event into the outbox inside `tx`; returns its id."""
    if type not in EVENT_TYPES:
        raise ValueError(f"unknown event type {type}")
    event_id = str(uuid.uuid4())
    envelope = {
        "id": event_id,
        "type": type,
        # R59: the clock time of the INSERT, inside the causing transaction.
        "occurredAt": iso(datetime.now(UTC)),
        "backend": "django",
        "requestId": context.request_id() if request_id is _UNSET else request_id,
        "data": data,
    }
    tx.execute(
        "INSERT INTO outbox_events (id, backend, type, payload) VALUES (%s, 'django', %s, %s::jsonb)",
        [event_id, type, json_dumps(envelope)],
    )
    pending: list[str] | None = getattr(tx, "_outbox_ids", None)
    if pending is None:
        pending = []
        tx._outbox_ids = pending  # type: ignore[attr-defined]
        tx.after_release(lambda: _relay_after_commit(list(pending)))
    pending.append(event_id)
    return event_id
