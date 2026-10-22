"""
RabbitMQ helpers of the Django processes beside Celery's own consumer (R55 topology, infra/rabbitmq/definitions.json —
nothing is declared here): a short-lived confirm channel for a raw publish (the delay copy of a busy `vsd.import`,
events.tasks.publish_delay_copy) and the ready-message count of a queue by a passive declare (metrics, the stand
test). Connections come from Celery's broker pool, configured with publisher confirms (`confirm_publish`).
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

log = logging.getLogger("agrotrace.amqp")


@contextmanager
def channel() -> Iterator[object]:
    """A fresh channel (confirm mode: every basic.publish waits for the broker's ack) on a pooled connection; closed
    afterwards. A failed operation drops the connection so the pool reconnects."""
    from agrotrace.celery_app import app

    with app.pool.acquire(block=True) as conn:
        ch = conn.channel()
        try:
            yield ch
        except Exception:
            try:
                conn.collect()
            except Exception:  # noqa: S110 - best effort; the pool replaces it
                pass
            raise
        else:
            try:
                ch.close()
            except Exception:  # noqa: S110 - the broker may have closed it
                pass


def queue_ready_count(queue: str | None = None) -> int | None:
    """Messages ready in `queue` (default `agrotrace.django.jobs`) by a passive queue.declare — None when the broker is
    unreachable or the queue is missing (never created here)."""
    from agrotrace.celery_app import QUEUE

    try:
        with channel() as ch:
            _name, count, _consumers = ch.queue_declare(queue=queue or QUEUE, passive=True)  # type: ignore[attr-defined]
            return int(count)
    except Exception as e:
        log.warning("queue count unavailable", extra={"err": str(e), "queue": queue or QUEUE})
        return None
