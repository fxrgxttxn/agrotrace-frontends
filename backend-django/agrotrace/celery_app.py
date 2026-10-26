"""
The Celery application of worker-django and beat-django (plan 3, «Очередь, воркер и планировщик»); the api uses it
to publish (infra/relay.py). The tasks are events.tasks (one per event `type`, the envelope as the single argument,
task_id = event id); the worker imports their modules at start (`imports`).

The topology is the one of infra/rabbitmq/definitions.json and is never declared by Celery:
- queue `agrotrace.django.jobs` on the topic exchange `agrotrace.django` (`#`), both `no_declare`, with exactly the
  definitions' queue arguments (quorum, DLX → `agrotrace.django.jobs.dlq`, delivery limit);
- default queue/exchange/type point there (send_task would otherwise go to `celery`), missing queues are never
  created, no remote control (`celery.pidbox`, reply queues), no task events, no gossip/mingle/heartbeat (the worker
  command), no result backend;
- the DelayedDelivery bootstep of Celery 5.5 (it declares `celery_delayed_*` once it sees a quorum queue) is removed
  from the consumer blueprint (`Consumer` below);
- quorum queues need per-consumer QoS (`worker_detect_quorum_queues`); late ack + reject on a lost worker; prefetch 1
  per thread (`-P threads -c 2 --prefetch-multiplier 1`).
Publishing happens only from the outbox (relay after commit, sweeper) with publisher confirms; business code never
calls delay()/apply_async()/retry() (test_static_guards.py).
"""

from __future__ import annotations

import json
import os
import threading

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agrotrace.settings")

import django  # noqa: E402
from celery import Celery  # noqa: E402
from celery.worker.consumer.consumer import Consumer as _CeleryConsumer  # noqa: E402
from kombu import Exchange, Queue  # noqa: E402

django.setup()

from agrotrace.core import config  # noqa: E402
from agrotrace.events.handlers import HANDLER_MODULES  # noqa: E402

EXCHANGE = "agrotrace.django"
QUEUE = "agrotrace.django.jobs"
DLQ = "agrotrace.django.jobs.dlq"
DELAY_QUEUE = "agrotrace.django.jobs.delay"


def _definitions() -> dict:
    return json.loads((config.ROOT / "infra" / "rabbitmq" / "definitions.json").read_text("utf-8"))


def queue_arguments(name: str = QUEUE) -> dict:
    """The arguments definitions.json gives the queue (a declaration with others would be refused by the broker)."""
    for q in _definitions()["queues"]:
        if q["name"] == name:
            return dict(q["arguments"])
    raise KeyError(name)


class Consumer(_CeleryConsumer):
    """Celery's consumer without the DelayedDelivery bootstep (no `celery_delayed_*` topology, ever), whose event loop
    is woken when a pool thread hands it work.

    With `-P threads` a task's ack (late ack) — and with it the broker's next delivery, prefetch being 2 — is a
    `call_soon` from the pool thread into the consumer's kombu hub; the hub only looks at its ready list between polls
    of up to 1 s and has no wake-up of its own, so every settle waited ~1 s (a busy `vsd.import` re-scheduled through
    the delay queue took a second per message: documents.test «worker concurrency», R92/P56). A self-pipe registered as a
    hub reader is written after every `call_soon`: the poll returns at once and the ack goes out."""

    class Blueprint(_CeleryConsumer.Blueprint):
        default_steps = [s for s in _CeleryConsumer.Blueprint.default_steps if "delayed_delivery" not in s]

    _wake_pipe: tuple[int, int] | None = None
    _wake_lock = threading.Lock()

    def call_soon(self, p, *args, **kwargs):
        promise = super().call_soon(p, *args, **kwargs)
        if self.hub is not None:
            self._wake()
        return promise

    def _wake(self) -> None:
        with self._wake_lock:
            if self._wake_pipe is None:
                r, w = os.pipe()
                os.set_blocking(r, False)
                os.set_blocking(w, False)
                self._wake_pipe = (r, w)
            r, w = self._wake_pipe
            if r not in self.hub.readers:  # (re)registered after a hub reset (connection restart)
                self.hub.add_reader(r, self._drain_wake)
        try:
            os.write(w, b"x")
        except BlockingIOError:
            pass  # the pipe is full: the hub is woken anyway

    def _drain_wake(self) -> None:
        try:
            while os.read(self._wake_pipe[0], 4096):  # type: ignore[index]
                pass
        except BlockingIOError:
            pass


app = Celery("agrotrace", set_as_current=True)

_exchange = Exchange(EXCHANGE, type="topic", durable=True, no_declare=True)

app.conf.update(
    broker_url=config.get().RABBITMQ_URL,
    broker_connection_retry_on_startup=True,
    # Fail fast (Q13 revised): a down broker costs the relay thread 2 s per attempt, never a request.
    broker_connection_timeout=2.0,
    broker_transport_options={"confirm_publish": True, "max_retries": 0, "connect_timeout": 2.0},
    broker_heartbeat=0,
    task_queues=[
        Queue(QUEUE, _exchange, routing_key="#", durable=True, queue_arguments=queue_arguments(), no_declare=True)
    ],
    task_default_queue=QUEUE,
    task_default_exchange=EXCHANGE,
    task_default_exchange_type="topic",
    task_default_routing_key="#",
    task_create_missing_queues=False,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_ignore_result=True,
    task_send_sent_event=False,
    task_serializer="json",
    accept_content=["json"],
    result_backend=None,
    result_expires=None,
    worker_enable_remote_control=False,
    worker_send_task_events=False,
    worker_detect_quorum_queues=True,
    worker_prefetch_multiplier=1,
    worker_hijack_root_logger=False,
    worker_redirect_stdouts=False,
    worker_consumer="agrotrace.celery_app:Consumer",
    # The worker imports the event tasks at start (each module registers its `type`; Tasks 9–12 add theirs).
    imports=tuple(dict.fromkeys(HANDLER_MODULES.values())),
    beat_max_loop_interval=1,
    beat_schedule={},
    timezone="UTC",
    enable_utc=True,
)
