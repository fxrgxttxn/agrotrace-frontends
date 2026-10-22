"""EventTask (events/tasks.py) with a fake producer: 5 in-process retries after 2…32 s, then Reject(requeue=False);
the claim (events/claim.py) — a claimed event has no effect; a busy `vsd.import` is re-scheduled by a raw kombu publish
of the same Celery v2 message to `agrotrace.django.jobs.delay` (mandatory, never send_task) and then settles; a failed
copy → a 1 s pause and Reject(requeue=True)."""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

import pytest
from celery.exceptions import Reject

from agrotrace.celery_app import app
from agrotrace.core import context, sql
from agrotrace.core.tx import with_tx
from agrotrace.events import claim, tasks
from agrotrace.events.handlers import vsd_import


def _envelope(type_: str = "vsd.import") -> dict:
    return {"id": str(uuid.uuid4()), "type": type_, "occurredAt": "2026-10-22T00:00:00.000Z", "backend": "django",
            "requestId": "req-1", "data": {"documentId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()),
                                           "publicCode": "AT-2026-000123"}}


@pytest.fixture
def sleeps(monkeypatch):
    out: list[float] = []
    monkeypatch.setattr(tasks, "_sleep", out.append)
    return out


@contextmanager
def delivered(task, envelope):
    task.push_request(id=envelope["id"], task=task.name, args=[envelope], kwargs={}, retries=0, root_id=envelope["id"],
                      parent_id=None, group=None, origin="gen1@worker")
    try:
        yield
    finally:
        task.pop_request()


def _task(name: str, fn, lane="default"):
    return tasks.event_task(name, lane=lane)(fn)


def test_a_failing_handler_is_retried_five_times_then_dead_lettered(sleeps):
    calls = []

    def boom(envelope):
        calls.append(context.current().event_request_id)
        raise RuntimeError("db down")

    task = _task("test.always-failing", boom)
    env = _envelope("test.always-failing")
    with delivered(task, env), pytest.raises(Reject) as err:
        task.process(env)
    assert err.value.requeue is False
    assert len(calls) == 6 and sleeps == [2, 4, 8, 16, 32]
    assert calls[0] == "req-1"  # the event's requestId tags the handler's context
    assert context.current() is None


def test_a_handler_that_recovers_returns(sleeps):
    calls = []

    def flaky(envelope):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("transient")

    task = _task("test.flaky", flaky)
    env = _envelope("test.flaky")
    with delivered(task, env):
        assert task.process(env) is None
    assert sleeps == [2, 4]


def test_the_registered_task_and_its_settings():
    import agrotrace.events.handlers.vsd_import  # noqa: F401

    t = app.tasks["vsd.import"]
    assert isinstance(t, tasks.EventTask) and t.lane == "vsd"
    assert t.acks_late and t.reject_on_worker_lost and t.ignore_result


def test_claim_is_once(db):
    event_id = str(uuid.uuid4())
    try:
        assert with_tx(lambda tx: claim.claim(tx, event_id)) is True
        assert with_tx(lambda tx: claim.claim(tx, event_id)) is False
        assert claim.already_claimed(event_id)
        assert sql.scalar("SELECT backend FROM processed_events WHERE event_id = %s", [event_id]) == "django"
    finally:
        sql.execute("DELETE FROM processed_events WHERE event_id = %s", [event_id])


def test_a_claimed_event_has_no_effect(db):
    env = _envelope()
    sql.execute("INSERT INTO processed_events (event_id, backend) VALUES (%s, 'django')", [env["id"]])

    class Never:
        def list_vsd(self, q):
            raise AssertionError("Mercury must not be called for a claimed event")

    try:
        before = sql.scalar("SELECT count(*) FROM processed_events")
        vsd_import.import_vsd(env, client=Never())  # type: ignore[arg-type]
        assert sql.scalar("SELECT count(*) FROM processed_events") == before
    finally:
        sql.execute("DELETE FROM processed_events WHERE event_id = %s", [env["id"]])


def test_an_unknown_document_is_only_claimed(db):
    env = _envelope()
    try:
        vsd_import.import_vsd(env, client=None)
        assert claim.already_claimed(env["id"])
    finally:
        sql.execute("DELETE FROM processed_events WHERE event_id = %s", [env["id"]])


class FakeProducer:
    published: list[tuple[tuple, dict]] = []
    fail: Exception | None = None

    def __init__(self, channel):
        self.channel = channel

    def publish(self, *args, **kwargs):
        FakeProducer.published.append((args, kwargs))
        if FakeProducer.fail is not None:
            raise FakeProducer.fail


@pytest.fixture
def fake_broker(monkeypatch):
    import kombu

    from agrotrace.infra import amqp

    FakeProducer.published = []
    FakeProducer.fail = None
    monkeypatch.setattr(kombu, "Producer", FakeProducer)

    @contextmanager
    def channel():
        yield object()

    monkeypatch.setattr(amqp, "channel", channel)

    def no_send_task(*a, **k):
        raise AssertionError("the delay copy must not go through send_task")

    monkeypatch.setattr(app, "send_task", no_send_task)
    return FakeProducer


def test_a_busy_vsd_import_is_copied_to_the_delay_queue_and_settled(fake_broker, sleeps):
    ran = []
    task = _task("test.vsd-lane", lambda env: ran.append(env), lane="vsd")
    env = _envelope("test.vsd-lane")
    lock = tasks.LANES["vsd"]
    assert lock.acquire(blocking=False)
    try:
        with delivered(task, env):
            assert task.process(env) is None
    finally:
        lock.release()
    assert ran == [] and sleeps == []
    [(args, kw)] = fake_broker.published
    assert kw["exchange"] == "" and kw["routing_key"] == "agrotrace.django.jobs.delay"
    assert kw["mandatory"] is True and kw["delivery_mode"] == 2 and kw["retry"] is False
    assert kw["content_type"] == "application/json" and kw["content_encoding"] == "utf-8"
    assert kw["correlation_id"] == env["id"]
    h = kw["headers"]
    assert h["id"] == env["id"] and h["task"] == "test.vsd-lane" and h["lang"] == "py"
    assert h["root_id"] == env["id"] and h["retries"] == 0 and h["origin"] == "gen1@worker"
    body = json.loads(args[0])
    assert body[0] == [env] and body[1] == {} and set(body[2]) == {"callbacks", "errbacks", "chain", "chord"}


def test_a_returned_or_nacked_copy_is_requeued_after_a_pause(fake_broker, sleeps):
    fake_broker.fail = RuntimeError("basic.return: NO_ROUTE")
    task = _task("test.vsd-lane-2", lambda env: None, lane="vsd")
    env = _envelope("test.vsd-lane-2")
    lock = tasks.LANES["vsd"]
    assert lock.acquire(blocking=False)
    try:
        with delivered(task, env), pytest.raises(Reject) as err:
            task.process(env)
    finally:
        lock.release()
    assert err.value.requeue is True and sleeps == [1.0]


def test_the_vsd_lane_is_free_after_a_handler(sleeps):
    task = _task("test.vsd-lane-3", lambda env: None, lane="vsd")
    env = _envelope("test.vsd-lane-3")
    with delivered(task, env):
        task.process(env)
    assert tasks.LANES["vsd"].acquire(blocking=False)
    tasks.LANES["vsd"].release()


def test_a_real_delay_copy_body_round_trips_through_celery():
    """The copy's body/headers are what Celery's own v2 builder produces for the same task call."""
    env = _envelope()

    class Req:
        id = env["id"]
        task = "vsd.import"
        args = [env]
        kwargs: dict = {}
        retries = 0
        root_id = env["id"]  # what send_task gives a root message
        parent_id = None
        group = None
        origin = None

    body, headers = tasks.delay_copy(Req())
    msg = app.amqp.as_task_v2(env["id"], "vsd.import", args=[env], kwargs={})
    assert json.loads(body) == json.loads(json.dumps(list(msg.body)))
    for k in ("lang", "task", "id", "eta", "expires", "group", "retries", "timelimit", "root_id", "parent_id"):
        assert headers[k] == (list(msg.headers[k]) if isinstance(msg.headers[k], tuple) else msg.headers[k]), k
