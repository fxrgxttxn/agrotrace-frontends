"""The Celery configuration (agrotrace/celery_app.py) lies on the contract's topology (plan 3, «Очередь, воркер и
планировщик»): queue and exchange `no_declare`, the queue arguments exactly those of infra/rabbitmq/definitions.json,
the default queue/exchange pointing there (topic), no missing-queue creation, no remote control and no events, late
ack + reject on a lost worker, prefetch multiplier 1, quorum detection, no DelayedDelivery step, no result backend,
publisher confirms."""

from __future__ import annotations

import json

import yaml

from agrotrace import celery_app
from agrotrace.celery_app import app
from agrotrace.core import config


def _definitions():
    return json.loads((config.ROOT / "infra" / "rabbitmq" / "definitions.json").read_text("utf-8"))


def test_the_queue_and_exchange_are_never_declared():
    [q] = app.conf.task_queues
    assert q.name == "agrotrace.django.jobs" and q.no_declare is True and q.routing_key == "#"
    assert q.exchange.name == "agrotrace.django" and q.exchange.type == "topic" and q.exchange.no_declare is True
    [defined] = [x for x in _definitions()["queues"] if x["name"] == "agrotrace.django.jobs"]
    assert q.queue_arguments == defined["arguments"]
    assert defined["arguments"]["x-queue-type"] == "quorum"
    names = {x["name"] for x in _definitions()["queues"]}
    assert {celery_app.QUEUE, celery_app.DLQ, celery_app.DELAY_QUEUE} <= names
    exchanges = {x["name"] for x in _definitions()["exchanges"]}
    assert celery_app.EXCHANGE in exchanges


def test_defaults_point_at_the_contract_topology():
    c = app.conf
    assert c.task_default_queue == "agrotrace.django.jobs"
    assert c.task_default_exchange == "agrotrace.django" and c.task_default_exchange_type == "topic"
    assert c.task_create_missing_queues is False


def test_no_remote_control_events_or_results():
    c = app.conf
    assert c.worker_enable_remote_control is False
    assert c.worker_send_task_events is False and c.task_send_sent_event is False
    assert c.result_backend is None and c.task_ignore_result is True


def test_delivery_semantics():
    c = app.conf
    assert c.task_acks_late is True and c.task_reject_on_worker_lost is True
    assert c.worker_prefetch_multiplier == 1 and c.worker_detect_quorum_queues is True
    assert c.broker_transport_options["confirm_publish"] is True


def test_the_delayed_delivery_step_is_not_in_the_consumer():
    steps = celery_app.Consumer.Blueprint.default_steps
    assert not any("delayed_delivery" in s.lower() or "DelayedDelivery" in s for s in steps)
    assert app.conf.worker_consumer == "agrotrace.celery_app:Consumer"
    from celery.worker.consumer.consumer import Consumer as Stock

    assert any("delayed_delivery" in s for s in Stock.Blueprint.default_steps)  # the stock one has it


def test_the_worker_imports_the_event_tasks():
    assert "agrotrace.events.handlers.vsd_import" in app.conf.imports
    assert "agrotrace.events.handlers.lab_escalate" in app.conf.imports


def test_the_compose_commands():
    compose = yaml.safe_load((config.ROOT / "docker-compose.yml").read_text("utf-8"))
    worker = compose["services"]["worker-django"]["command"]
    assert worker[:4] == ["celery", "-A", "agrotrace.celery_app", "worker"]
    for flag in ("--without-gossip", "--without-mingle", "--without-heartbeat"):
        assert flag in worker
    assert worker[worker.index("-Q") + 1] == "agrotrace.django.jobs"
    assert worker[worker.index("-P") + 1] == "threads" and worker[worker.index("-c") + 1] == "2"
    assert worker[worker.index("--prefetch-multiplier") + 1] == "1"
    beat = compose["services"]["beat-django"]["command"]
    assert beat[beat.index("-S") + 1] == "agrotrace.scheduler.beat:InProcessScheduler"


def test_a_call_soon_from_a_pool_thread_wakes_the_consumer_hub():
    """Late acks of `-P threads` are `call_soon`s into the kombu hub, which polls up to 1 s between looks at its ready
    list: our consumer writes a self-pipe registered as a hub reader, so the poll returns at once."""
    import os
    import select
    import threading

    from agrotrace import celery_app

    class FakeHub:
        def __init__(self):
            self.readers = {}
            self.ready = []

        def call_soon(self, p):
            self.ready.append(p)

        def add_reader(self, fd, cb):
            self.readers[fd] = cb

    c = celery_app.Consumer.__new__(celery_app.Consumer)
    c.hub = FakeHub()
    c._wake_pipe = None
    t = threading.Thread(target=lambda: c.call_soon(lambda: None))
    t.start()
    t.join()
    r, _w = c._wake_pipe
    assert len(c.hub.ready) == 1 and r in c.hub.readers
    assert select.select([r], [], [], 0)[0] == [r]  # readable: a poll returns at once
    c.hub.readers[r]()
    assert select.select([r], [], [], 0)[0] == []  # drained
    c.hub.readers.clear()  # a hub reset (connection restart): registered again on the next call
    c.call_soon(lambda: None)
    assert r in c.hub.readers
    os.close(r)
    os.close(_w)
