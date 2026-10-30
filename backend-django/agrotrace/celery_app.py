"""
The Celery application of worker-django and beat-django (plan 3, «Очередь, воркер и планировщик»); the api uses it
to publish (infra/relay.py). The tasks are events.tasks (one per event `type`, the envelope as the single argument,
task_id = event id); the worker imports their modules at start (`imports`).

The topology is the one of infra/rabbitmq/definitions.json and is never declared by Celery:
- queue `agrotrace.django.jobs` on the topic exchange `agrotrace.django` (`#`), both `no_declare`, with exactly the
  definitions' queue arguments (quorum, DLX → `agrotrace.django.jobs.dlq`, delivery limit);
- default queue/exchange/type point there (send_task would otherwise go to `celery`), missing queues are never
  created, no remote control (`celery.pidbox`, reply queues), no task events, no gossip/mingle/event heartbeat (the worker
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

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agrotrace.settings")

import django  # noqa: E402
from celery import Celery  # noqa: E402
from celery.signals import worker_shutting_down  # noqa: E402
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

    def register_with_event_loop(self, hub):
        """On the hub thread, at every loop start (asynloop calls it after each hub reset): the wake pipe becomes a
        reader of this hub. Pool threads never touch the hub's reader table (M1 of the Task 12 review)."""
        super().register_with_event_loop(hub)
        if self._wake_pipe is None:
            r, w = os.pipe()
            os.set_blocking(r, False)
            os.set_blocking(w, False)
            self._wake_pipe = (r, w)
        hub.add_reader(self._wake_pipe[0], self._drain_wake)

    def call_soon(self, p, *args, **kwargs):
        promise = super().call_soon(p, *args, **kwargs)
        pipe = self._wake_pipe
        if self.hub is not None and pipe is not None:
            try:
                os.write(pipe[1], b"x")  # the only thing a pool thread does: a non-blocking write
            except BlockingIOError:
                pass  # the pipe is full: the hub is woken anyway
        return promise

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
    # AMQP heartbeats of the worker's consumer connection, 60 s as amqplib (Express) negotiates with the broker: a
    # half-open connection is noticed in minutes, not after the kernel's keepalive (final review M3). Only the consumer
    # uses it (Celery: producers/pool connections send none, so an idle pooled connection is never dropped for it).
    broker_heartbeat=60,
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


@worker_shutting_down.connect
def _shutdown_watchdog(**_kwargs) -> None:
    """SIGTERM/SIGINT: a warm shutdown still running SHUTDOWN_TIMEOUT_MS + 2 s later ends the process (exit 1), as
    Express's onShutdown (core/lifecycle.py). Handlers that fail from now on return their delivery to the queue (PL13)."""
    from agrotrace.core import lifecycle
    from agrotrace.events import tasks

    tasks.STOPPING.set()
    lifecycle.exit_after(config.get().SHUTDOWN_TIMEOUT_MS)
