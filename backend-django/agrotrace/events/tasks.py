"""
Event tasks of worker-django (R55, R56, R92, P56; contracts/events/envelope.schema.json; plan 3 «Очередь, воркер и
планировщик»), the port of backend-express/src/infra/consumer.ts on Celery: every event `type` is a Celery task of
that name whose single argument is the envelope (`task_id` = event id). `@event_task(type)` registers a handler
`fn(envelope) -> None` as an `EventTask`:

- the handler claims the event itself, as the first statement of its transaction (events.claim, R56);
- a failing handler is retried in this thread after 2, 4, 8, 16 and 32 s (each attempt its own transactions — the
  handler's business), then the message is rejected without requeue and dead-letters to `agrotrace.django.jobs.dlq`
  (`Reject(requeue=False)` under late ack);
- `lane='vsd'`: at most ONE such handler runs per process (a Mercury outage holds it for about two minutes). One
  delivered while another runs is re-scheduled at once (P56): `publish_delay_copy` publishes the same Celery message to
  `agrotrace.django.jobs.delay` (TTL 5 s, then dead-lettered to the TAIL of the jobs queue) as `mandatory` with a
  publisher confirm, and only then does the task return (late ack: acknowledged). A returned or negatively confirmed
  copy is not acknowledged: after a 1 s pause the delivery goes back with `Reject(requeue=True)` — a broker-side failure
  only, never the busy path (final review I1 of Express).

The copy is published with raw kombu, not `send_task`: Celery would put its default exchange in place of the empty
one, and through the `#` binding the copy would come back to the jobs queue at once (D-I6).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any, Literal

from celery import Task
from celery.exceptions import Reject

from agrotrace.celery_app import DELAY_QUEUE, app
from agrotrace.core import context

log = logging.getLogger("agrotrace.events")

#: Pauses before the 2nd … 6th attempt of a failing handler (envelope: 5 retries).
RETRY_DELAYS_S: tuple[float, ...] = (2, 4, 8, 16, 32)
#: Pause before a delivery whose delay copy failed goes back to the queue.
REQUEUE_PAUSE_S = 1.0
CONFIRM_TIMEOUT_S = 10.0

Handler = Callable[[dict[str, Any]], None]

#: One process-wide slot per exclusive lane (R92: one `vsd.import` handler at a time).
LANES: dict[str, threading.Lock] = {"vsd": threading.Lock()}

#: Set when the worker starts its warm shutdown (celery_app.py): a handler that fails from then on is not retried and
#: not dead-lettered — its delivery goes back to the queue (PL13), as on Express and Laravel.
STOPPING = threading.Event()


def _sleep(seconds: float) -> None:  # tests replace it
    STOPPING.wait(seconds)


class EventTask(Task):
    """A Celery task running one event handler (`handler`, `lane` — set by `event_task`)."""

    handler: Handler
    lane: str = "default"
    acks_late = True
    reject_on_worker_lost = True
    ignore_result = True
    typing = False

    def process(self, envelope: dict[str, Any]) -> None:
        lock = LANES.get(self.lane)
        if lock is not None and not lock.acquire(blocking=False):
            self._reschedule(envelope)
            return
        try:
            self._handle(envelope)
        finally:
            if lock is not None:
                lock.release()

    def _reschedule(self, envelope: dict[str, Any]) -> None:
        try:
            publish_delay_copy(self.request)
        except Exception as e:
            log.error("delay copy failed; the delivery is requeued", exc_info=e,
                      extra={"eventId": envelope.get("id"), "type": self.name})
            _sleep(REQUEUE_PAUSE_S)
            raise Reject(e, requeue=True) from e
        log.info("busy; re-scheduled through the delay queue", extra={"eventId": envelope.get("id"),
                                                                       "type": self.name})

    def _handle(self, envelope: dict[str, Any]) -> None:
        for attempt in range(len(RETRY_DELAYS_S) + 1):
            # The handled event's requestId tags the handler's log lines; audit rows stay system (request_id null).
            token = context.bind(context.RequestContext(event_request_id=envelope.get("requestId")))
            try:
                type(self).handler(envelope)
                return
            except Exception as e:
                if STOPPING.is_set():
                    log.warning("event handler failed while stopping; left to the broker",
                                extra={"err": str(e), "eventId": envelope.get("id"), "type": self.name})
                    raise Reject(e, requeue=True) from e
                if attempt >= len(RETRY_DELAYS_S):
                    log.error("event handler failed; dead-lettering", exc_info=e,
                              extra={"eventId": envelope.get("id"), "type": self.name})
                    raise Reject(e, requeue=False) from e
                log.warning("event handler failed; retrying",
                            extra={"err": str(e), "eventId": envelope.get("id"), "type": self.name,
                                   "attempt": attempt + 1})
            finally:
                context.reset(token)
            _sleep(RETRY_DELAYS_S[attempt])


def event_task(type: str, *, lane: Literal["vsd", "default"] = "default") -> Callable[[Handler], EventTask]:  # noqa: A002
    """Registers `fn(envelope)` as the Celery task of the event `type`."""

    def register(fn: Handler) -> EventTask:
        def run(self: EventTask, envelope: dict[str, Any]) -> None:
            self.process(envelope)

        run.__module__ = fn.__module__
        return app.task(name=type, base=EventTask, bind=True, handler=staticmethod(fn), lane=lane)(run)

    return register


def _headers(request: Any) -> dict[str, Any]:
    """The Celery v2 message headers of the delivery `request` (the same task name and id: the copy IS the message)."""
    return {
        "lang": "py",
        "task": request.task,
        "id": request.id,
        "shadow": None,
        "eta": None,
        "expires": None,
        "group": getattr(request, "group", None),
        "group_index": getattr(request, "group_index", None),
        "retries": getattr(request, "retries", 0) or 0,
        "timelimit": [None, None],
        "root_id": getattr(request, "root_id", None),
        "parent_id": getattr(request, "parent_id", None),
        "argsrepr": getattr(request, "argsrepr", None),
        "kwargsrepr": getattr(request, "kwargsrepr", None),
        "origin": getattr(request, "origin", None),
        "ignore_result": True,
    }


def delay_copy(request: Any) -> tuple[str, dict[str, Any]]:
    """(body, headers) of the copy: the Celery v2 body `[args, kwargs, embed]` as JSON text."""
    from kombu.utils.json import dumps

    embed = {"callbacks": None, "errbacks": None, "chain": None, "chord": None}
    return dumps([list(request.args or []), dict(request.kwargs or {}), embed]), _headers(request)


def publish_delay_copy(request: Any) -> None:
    """Publishes the delivery `request` again — the same Celery v2 message — to `agrotrace.django.jobs.delay` through
    the default exchange: persistent, `mandatory`, confirmed. Raises when the broker returns the copy (basic.return: the
    queue is missing), refuses it (nack) or does not confirm in time."""
    from kombu import Producer

    from agrotrace.infra import amqp

    body, headers = delay_copy(request)
    with amqp.channel() as ch:
        Producer(ch).publish(
            body,
            exchange="",
            routing_key=DELAY_QUEUE,
            headers=headers,
            content_type="application/json",
            content_encoding="utf-8",
            delivery_mode=2,
            correlation_id=request.id,
            mandatory=True,
            retry=False,
            confirm_timeout=CONFIRM_TIMEOUT_S,
        )
