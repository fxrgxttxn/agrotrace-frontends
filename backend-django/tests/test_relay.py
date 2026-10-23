"""The outbox relay and sweeper (infra/relay.py, scheduler/jobs/outbox_sweeper.py) with a fake broker:

- a rolled-back transaction publishes nothing; after the commit the relay THREAD sends `send_task(type,
  args=[envelope], task_id=id, exchange='agrotrace.django', routing_key=type)` and marks `published_at`;
- the request never waits on the broker (a 2 s confirm does not delay the committing thread);
- only types with a handler are published (Ruling Q12) — the others stay unpublished, by the relay and the sweeper;
- relay vs sweeper on one row: the row is held across send + confirm, so it is sent exactly once (Q13 revised);
- a failed confirm leaves the row for the sweeper and backs the relay off; the sweeper keeps the retention (R59)."""

from __future__ import annotations

import json
import threading
import time
import uuid
from contextlib import contextmanager

import pytest
from django.db import connections

from agrotrace.celery_app import app
from agrotrace.core import sql
from agrotrace.core.tx import with_tx
from agrotrace.events.handlers import HANDLED_TYPES, HANDLER_MODULES
from agrotrace.infra import outbox, relay
from agrotrace.scheduler.jobs import outbox_sweeper

pytestmark = pytest.mark.relay


class Broker:
    def __init__(self):
        self.sent: list[dict] = []
        self.fail_on: set[str] = set()
        self.confirm_s = 0.0
        self.lock = threading.Lock()
        self.unreachable = False
        self.channel_opened_in_tx: list[bool] = []

    def send_task(self, name, args=None, **kw):
        if self.confirm_s:
            time.sleep(self.confirm_s)
        if kw["task_id"] in self.fail_on:
            raise TimeoutError("publisher confirm timed out")
        with self.lock:
            self.sent.append({"name": name, "args": args, "thread": threading.current_thread().name, **kw})


@pytest.fixture
def broker(monkeypatch):
    b = Broker()
    monkeypatch.setattr(app, "send_task", b.send_task)

    class P:
        class connection:  # noqa: N801
            @staticmethod
            def collect():
                pass

        @property
        def channel(self):
            # The relay opens the channel before its transaction (N1 of the Task 6 re-review).
            b.channel_opened_in_tx.append(connections["default"].in_atomic_block)
            if b.unreachable:
                raise ConnectionRefusedError("broker unreachable")
            return object()

    @contextmanager
    def acquire():
        yield P()

    monkeypatch.setattr(app, "producer_or_acquire", acquire)
    r = relay.relay()
    r._down_until = 0.0
    r._backoff = relay.BACKOFF_MIN_S
    yield b
    assert r.wait_idle(15)
    r._down_until = 0.0


@pytest.fixture
def rows(db):
    made: list[str] = []
    yield made
    if made:
        sql.execute("DELETE FROM outbox_events WHERE id = ANY(%s::uuid[])", [made])


def _row(event_id):
    return sql.one("SELECT published_at, attempts, payload FROM outbox_events WHERE id = %s", [event_id])


def _insert(event_id, *, type_="vsd.import", published_days_ago=None, backend="django"):
    sql.execute(
        "INSERT INTO outbox_events (id, backend, type, payload, published_at) VALUES (%s, %s, %s, %s::jsonb, "
        + ("now() - make_interval(days => %s))" if published_days_ago is not None else "NULL)"),
        [event_id, backend, type_, json.dumps({"id": event_id, "type": type_, "data": {}}),
         *([published_days_ago] if published_days_ago is not None else [])])


def test_the_handled_types_are_the_registered_tasks():
    import importlib

    assert HANDLED_TYPES == ("vsd.import", "lab.escalate")
    assert set(app.conf.imports) == set(HANDLER_MODULES.values())
    for type_, module in HANDLER_MODULES.items():
        importlib.import_module(module)
        assert type_ in app.tasks


def test_a_rolled_back_transaction_publishes_nothing(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "vsd.import", {"documentId": "d"}))
        raise RuntimeError("rollback")

    with pytest.raises(RuntimeError):
        with_tx(fn)
    assert relay.relay().wait_idle()
    assert broker.sent == [] and _row(rows[0]) is None


def test_after_commit_the_relay_thread_sends_then_marks(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "vsd.import", {"n": 1}))
        rows.append(outbox.enqueue(tx, "vsd.import", {"n": 2}))
        assert broker.sent == []  # nothing before the commit

    with_tx(fn)
    assert relay.relay().wait_idle()
    assert [s["task_id"] for s in broker.sent] == rows
    first = broker.sent[0]
    assert first["name"] == "vsd.import" and first["routing_key"] == "vsd.import"
    assert first["exchange"] == "agrotrace.django" and first["delivery_mode"] == 2 and first["retry"] is False
    assert first["confirm_timeout"] == relay.CONFIRM_TIMEOUT_S
    assert first["thread"] == "outbox-relay"
    assert first["args"] == [sql.jsonb(_row(rows[0])["payload"])] and first["args"][0]["id"] == rows[0]
    for r in rows:
        row = _row(r)
        assert row["published_at"] is not None and row["attempts"] == 1


def test_the_request_never_waits_on_the_broker(broker, rows):
    broker.confirm_s = 2.0
    t0 = time.monotonic()
    with_tx(lambda tx: rows.append(outbox.enqueue(tx, "vsd.import", {})))
    assert time.monotonic() - t0 < 0.5
    assert relay.relay().wait_idle(10)
    assert [s["task_id"] for s in broker.sent] == rows


def test_types_without_a_handler_stay_unpublished(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "notification.dispatch", {}))
        rows.append(outbox.enqueue(tx, "rating.recalculate", {}))
        rows.append(outbox.enqueue(tx, "recall.requested", {}))

    with_tx(fn)
    assert relay.relay().wait_idle()
    outbox_sweeper.run()
    assert all(s["task_id"] not in rows for s in broker.sent)
    assert all(_row(r)["published_at"] is None for r in rows)


def test_relay_and_sweeper_on_one_row_send_it_exactly_once(broker, rows):
    """Q13 revised: the relay holds the row FOR NO KEY UPDATE across send + confirm; a sweeper pass during the confirm
    skips it."""
    for gap in (0.05, 0.5):
        event_id = str(uuid.uuid4())
        _insert(event_id)
        rows.append(event_id)
        broker.sent.clear()
        broker.confirm_s = 1.0
        results = {}

        def via_relay(eid=event_id, results=results):
            results["relay"] = relay.flush([eid])
            connections.close_all()

        def via_sweeper(g=gap, results=results):
            time.sleep(g)
            results["sweeper"] = outbox_sweeper.run()
            connections.close_all()

        a = threading.Thread(target=via_relay, name="relay")
        b = threading.Thread(target=via_sweeper, name="sweeper")
        a.start()
        b.start()
        a.join()
        b.join()
        mine = [s for s in broker.sent if s["task_id"] == event_id]
        assert len(mine) == 1, (gap, mine)
        assert mine[0]["thread"] == "relay" and results["sweeper"] == 0
        assert _row(event_id)["attempts"] == 1


def test_a_failed_confirm_leaves_the_row_and_backs_off(broker, rows):
    r = relay.relay()
    first = str(uuid.uuid4())
    _insert(first)
    rows.append(first)
    broker.fail_on = {first}
    relay.publish([first])
    assert r.wait_idle()
    assert _row(first)["published_at"] is None and _row(first)["attempts"] == 0
    assert r.broker_down()  # backing off: the next batch is left to the sweeper at once
    second = str(uuid.uuid4())
    _insert(second)
    rows.append(second)
    broker.fail_on = set()
    relay.publish([second])
    assert r.wait_idle()
    assert _row(second)["published_at"] is None
    assert outbox_sweeper.run() >= 2  # the sweeper is the guarantee
    assert _row(first)["published_at"] is not None and _row(second)["published_at"] is not None


def test_a_second_publish_of_a_published_row_does_nothing(broker, rows):
    with_tx(lambda tx: rows.append(outbox.enqueue(tx, "vsd.import", {})))
    assert relay.relay().wait_idle()
    assert relay.flush(rows) == (0, False)
    assert len([s for s in broker.sent if s["task_id"] == rows[0]]) == 1 and _row(rows[0])["attempts"] == 1


def test_the_sweeper_publishes_and_keeps_the_retention(broker, rows):
    fresh, express, old, recent, unhandled = (str(uuid.uuid4()) for _ in range(5))
    _insert(fresh)
    _insert(express, backend="express")
    _insert(old, published_days_ago=8)
    _insert(recent, published_days_ago=6)
    _insert(unhandled, type_="rating.recalculate")
    rows.extend([fresh, express, old, recent, unhandled])
    seen_old, seen_recent = str(uuid.uuid4()), str(uuid.uuid4())
    sql.execute("INSERT INTO processed_events (event_id, backend, processed_at) VALUES "
                "(%s, 'django', now() - interval '31 days'), (%s, 'django', now() - interval '29 days')",
                [seen_old, seen_recent])
    try:
        n = outbox_sweeper.run()
        sent = [s["task_id"] for s in broker.sent]
        assert n >= 1 and fresh in sent
        assert express not in sent and unhandled not in sent  # this backend's rows, handled types only
        assert _row(fresh)["published_at"] is not None and _row(express)["published_at"] is None
        assert _row(unhandled)["published_at"] is None
        assert _row(old) is None and _row(recent) is not None
        left = {r["event_id"] for r in sql.all("SELECT event_id::text FROM processed_events WHERE event_id = "
                                                "ANY(%s::uuid[])", [[seen_old, seen_recent]])}
        assert left == {seen_recent}
    finally:
        sql.execute("DELETE FROM processed_events WHERE event_id = ANY(%s::uuid[])", [[seen_old, seen_recent]])


def test_the_sweeper_skips_while_another_holds_its_lock(broker, rows, other_session):
    event_id = str(uuid.uuid4())
    _insert(event_id)
    rows.append(event_id)
    with other_session.transaction():
        other_session.execute("SELECT pg_advisory_xact_lock(hashtext('agrotrace.outbox.django'))")
        assert outbox_sweeper.run() == 0
    assert broker.sent == [] and _row(event_id)["published_at"] is None


def test_beat_has_no_relay_thread(monkeypatch, broker):
    monkeypatch.setenv("AGROTRACE_PROCESS", "beat")
    calls = []
    monkeypatch.setattr(relay.relay(), "submit", lambda ids: calls.append(ids))
    relay.publish(["x"])
    assert calls == []


def test_the_sweeper_is_a_beat_job_every_5_s():
    from agrotrace.scheduler import beat, jobs

    assert beat.outbox_sweeper.JOB is jobs.REGISTRY["outbox-sweeper"]
    assert jobs.REGISTRY["outbox-sweeper"].period_ms == 5000


def test_the_broker_channel_is_opened_before_the_transaction(broker, rows):
    """N1 (Task 6 re-review): relay and sweeper open the confirm channel first, as Express does — a reconnect never
    holds a pool connection's transaction, row locks or the sweeper's advisory lock."""
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    _insert(first)
    _insert(second)
    rows.extend([first, second])
    assert relay.flush([first])[0] == 1
    assert outbox_sweeper.run() >= 1
    assert broker.channel_opened_in_tx and not any(broker.channel_opened_in_tx)


def test_an_unreachable_broker_opens_no_transaction(broker, rows, monkeypatch):
    event_id = str(uuid.uuid4())
    _insert(event_id)
    rows.append(event_id)
    broker.unreachable = True
    opened = []
    import agrotrace.core.tx as txmod

    real = txmod.with_tx
    monkeypatch.setattr(txmod, "with_tx", lambda *a, **kw: opened.append(1) or real(*a, **kw))
    assert relay.flush([event_id]) == (0, True)
    assert opened == [] and broker.sent == []
    assert _row(event_id)["published_at"] is None and _row(event_id)["attempts"] == 0
    # The sweeper still keeps the retention, and publishes nothing.
    assert outbox_sweeper.run() == 0 and broker.sent == []
