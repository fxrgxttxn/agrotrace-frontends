"""The outbox relay and sweeper (infra/relay.py, scheduler/jobs/outbox_sweeper.py) with a fake broker: a rolled-back
transaction publishes nothing; after the commit `send_task(type, args=[envelope], task_id=id, exchange='agrotrace.django',
routing_key=type)` runs with no pool connection held, then `published_at`; a failed confirm leaves the row for the
sweeper; the sweeper publishes the oldest rows under its advisory lock and applies the retention (R59)."""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

import pytest

from agrotrace.celery_app import app
from agrotrace.core import sql
from agrotrace.core.tx import with_tx
from agrotrace.infra import outbox, relay
from agrotrace.scheduler.jobs import outbox_sweeper

pytestmark = pytest.mark.relay


class Broker:
    def __init__(self):
        self.sent: list[dict] = []
        self.fail_on: set[str] = set()
        self.held: list[bool] = []

    def send_task(self, name, args=None, **kw):
        self.held.append(sql.holds_connection())
        if kw["task_id"] in self.fail_on:
            raise TimeoutError("publisher confirm timed out")
        self.sent.append({"name": name, "args": args, **kw})


@pytest.fixture
def broker(monkeypatch):
    b = Broker()
    monkeypatch.setattr(app, "send_task", b.send_task)

    class P:
        class connection:  # noqa: N801
            @staticmethod
            def collect():
                pass

    @contextmanager
    def acquire():
        yield P()

    monkeypatch.setattr(app, "producer_or_acquire", acquire)
    return b


@pytest.fixture
def rows(db):
    made: list[str] = []
    yield made
    if made:
        sql.execute("DELETE FROM outbox_events WHERE id = ANY(%s::uuid[])", [made])


def _row(event_id):
    return sql.one("SELECT published_at, attempts, payload FROM outbox_events WHERE id = %s", [event_id])


def test_a_rolled_back_transaction_publishes_nothing(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "vsd.import", {"documentId": "d"}))
        raise RuntimeError("rollback")

    with pytest.raises(RuntimeError):
        with_tx(fn)
    assert broker.sent == [] and _row(rows[0]) is None


def test_after_commit_the_row_is_sent_then_marked(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "notification.dispatch", {"n": 1}))
        rows.append(outbox.enqueue(tx, "vsd.import", {"n": 2}))
        assert broker.sent == []  # nothing before the commit

    with_tx(fn)
    assert [s["task_id"] for s in broker.sent] == rows
    first = broker.sent[0]
    assert first["name"] == "notification.dispatch" and first["routing_key"] == "notification.dispatch"
    assert first["exchange"] == "agrotrace.django" and first["delivery_mode"] == 2 and first["retry"] is False
    assert first["confirm_timeout"] == 10.0
    stored = _row(rows[0])
    assert first["args"] == [sql.jsonb(stored["payload"])] and first["args"][0]["id"] == rows[0]
    assert broker.held == [False, False]  # P61: no pool connection while the broker confirms
    for r in rows:
        row = _row(r)
        assert row["published_at"] is not None and row["attempts"] == 1


def test_a_failed_confirm_leaves_the_row_for_the_sweeper(broker, rows):
    def fn(tx):
        rows.append(outbox.enqueue(tx, "lab.escalate", {}))
        rows.append(outbox.enqueue(tx, "lab.escalate", {}))

    broker.fail_on = set()

    def failing_first(name, args=None, **kw):
        broker.fail_on.add(kw["task_id"])
        return Broker.send_task(broker, name, args, **kw)

    app.send_task = failing_first  # the fixture's monkeypatch restores it
    with_tx(fn)
    first, second = (_row(r) for r in rows)
    assert first["published_at"] is None and first["attempts"] == 0
    assert second["published_at"] is None  # the pass stopped at the failure
    app.send_task = broker.send_task
    broker.fail_on = set()
    relay.publish(rows)
    assert all(_row(r)["published_at"] is not None for r in rows)


def test_a_second_publish_of_a_published_row_does_nothing(broker, rows):
    with_tx(lambda tx: rows.append(outbox.enqueue(tx, "rating.recalculate", {})))
    relay.publish(rows)
    assert len(broker.sent) == 1 and _row(rows[0])["attempts"] == 1


def _insert(event_id, *, published_days_ago=None, backend="django"):
    sql.execute(
        "INSERT INTO outbox_events (id, backend, type, payload, published_at) VALUES (%s, %s, 'lab.escalate', %s::jsonb, "
        + ("now() - make_interval(days => %s))" if published_days_ago is not None else "NULL)"),
        [event_id, backend, json.dumps({"id": event_id, "type": "lab.escalate", "data": {}}),
         *([published_days_ago] if published_days_ago is not None else [])])


def test_the_sweeper_publishes_and_keeps_the_retention(broker, rows):
    fresh, express, old, recent = (str(uuid.uuid4()) for _ in range(4))
    _insert(fresh)
    _insert(express, backend="express")
    _insert(old, published_days_ago=8)
    _insert(recent, published_days_ago=6)
    rows.extend([fresh, express, old, recent])
    seen_old, seen_recent = str(uuid.uuid4()), str(uuid.uuid4())
    sql.execute("INSERT INTO processed_events (event_id, backend, processed_at) VALUES "
                "(%s, 'django', now() - interval '31 days'), (%s, 'django', now() - interval '29 days')",
                [seen_old, seen_recent])
    try:
        n = outbox_sweeper.run()
        assert n >= 1 and fresh in [s["task_id"] for s in broker.sent]
        assert express not in [s["task_id"] for s in broker.sent]  # only this backend's rows
        assert _row(fresh)["published_at"] is not None and _row(express)["published_at"] is None
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


def test_the_sweeper_is_a_beat_job_every_5_s():
    from agrotrace.scheduler import beat, jobs

    assert beat.outbox_sweeper.JOB is jobs.REGISTRY["outbox-sweeper"]
    assert jobs.REGISTRY["outbox-sweeper"].period_ms == 5000
