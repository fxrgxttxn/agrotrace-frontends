"""
Stand check (marker `stand`: `./at.sh django:test -m stand` with the stand up and worker-django running this code):

1. the broker holds only the names of infra/rabbitmq/definitions.json — no `celery*`, `*.pidbox`, `celeryev*`,
   `celery_delayed_*` exchange or queue (Celery declares nothing);
2. D-I6: a copy of a busy `vsd.import`, published by `publish_delay_copy`, is seen waiting in
   `agrotrace.django.jobs.delay` (a passive queue.declare, polled) and comes back to `agrotrace.django.jobs` only after
   the queue's 5 s TTL (dead-lettered to the tail) — seen as the worker's claim of the event in `processed_events` of
   the dev DB, within a generous deadline (the shared stand's queues need not be idle). The event id is new and has no
   outbox row; the document does not exist, so the worker only claims it (vsd.import step 1); the claim is removed
   afterwards.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

import psycopg
import pytest

from agrotrace.celery_app import DELAY_QUEUE
from agrotrace.core import config
from agrotrace.events import tasks
from agrotrace.infra import amqp

pytestmark = pytest.mark.stand

FORBIDDEN_PREFIXES = ("celery", "celeryev", "celery_delayed_")


def _management(path: str):
    u = urllib.parse.urlsplit(config.get().RABBITMQ_URL)
    auth = base64.b64encode(f"{urllib.parse.unquote(u.username or '')}:{urllib.parse.unquote(u.password or '')}"
                            .encode()).decode()
    req = urllib.request.Request(f"http://{u.hostname}:15672/api/{path}", headers={"authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=5) as res:  # noqa: S310 - the stand's broker
        return json.loads(res.read())


def _names(kind: str) -> set[str]:
    return {x["name"] for x in _management(f"{kind}/%2F")}


def test_the_broker_has_only_the_definitions_names():
    defs = json.loads((config.ROOT / "infra" / "rabbitmq" / "definitions.json").read_text("utf-8"))
    consumers = _management("queues/%2F/agrotrace.django.jobs")["consumers"]
    assert consumers >= 1, "worker-django must be running (./at.sh up django)"
    for kind in ("queues", "exchanges"):
        names = _names(kind)
        bad = {n for n in names if n.startswith(FORBIDDEN_PREFIXES) or n.endswith(".pidbox")}
        assert not bad, f"{kind}: {sorted(bad)}"
        declared = {x["name"] for x in defs[kind]}
        unexpected = {n for n in names if n and not n.startswith("amq.") and n not in declared}
        assert not unexpected, f"{kind} outside definitions.json: {sorted(unexpected)}"


class _Request:
    def __init__(self, envelope):
        self.id = envelope["id"]
        self.task = "vsd.import"
        self.args = [envelope]
        self.kwargs = {}
        self.retries = 0
        self.root_id = None
        self.parent_id = None
        self.group = None
        self.origin = "stand-test"


def _claimed(conn, event_id) -> bool:
    return conn.execute("SELECT EXISTS (SELECT 1 FROM processed_events WHERE event_id = %s)", [event_id]).fetchone()[0]


#: The delay queue's x-message-ttl (definitions.json); the copy cannot reach the jobs queue before it.
DELAY_TTL_S = 5.0
#: How long the copy may take to come back and be claimed. Generous: the jobs queue may hold other work (the stand is
#: shared, nothing assumes idle queues), and the worker takes it in FIFO order.
CLAIM_DEADLINE_S = 60.0


def test_a_delay_copy_returns_to_the_jobs_queue_after_the_ttl():
    """The queue state is polled (a passive queue.declare, exact and immediate), never the management API's sampled
    stats; no assertion assumes the delay or jobs queue is otherwise empty."""
    dev_db = os.environ["APP_DATABASE_URL"]  # the stand's dev DB, where worker-django claims
    event_id = str(uuid.uuid4())
    envelope = {"id": event_id, "type": "vsd.import", "occurredAt": "2026-10-22T00:00:00.000Z", "backend": "django",
                "requestId": None, "data": {"documentId": str(uuid.uuid4()), "batchId": str(uuid.uuid4()),
                                            "publicCode": "AT-2026-999999"}}
    with psycopg.connect(dev_db, autocommit=True) as conn:
        try:
            assert conn.execute("SELECT count(*) FROM outbox_events WHERE id = %s", [event_id]).fetchone()[0] == 0
            t0 = time.monotonic()
            tasks.publish_delay_copy(_Request(envelope))
            waiting_seen = False
            claimed_at = None
            while time.monotonic() - t0 < CLAIM_DEADLINE_S:
                if _claimed(conn, event_id):
                    claimed_at = time.monotonic() - t0
                    break
                if not waiting_seen:
                    count = amqp.queue_ready_count(DELAY_QUEUE)
                    waiting_seen = count is not None and count >= 1
                time.sleep(0.1)
            assert claimed_at is not None, f"the copy was not claimed within {CLAIM_DEADLINE_S:.0f} s"
            assert claimed_at >= DELAY_TTL_S - 1.0, (
                f"the copy reached the jobs queue after {claimed_at:.2f} s, before the {DELAY_TTL_S:.0f} s TTL")
            assert waiting_seen, "the copy was never seen waiting in agrotrace.django.jobs.delay"
        finally:
            conn.execute("DELETE FROM processed_events WHERE event_id = %s", [event_id])


def test_a_copy_the_broker_cannot_route_is_a_failure(monkeypatch):
    """`mandatory`: a copy that reaches no queue comes back as basic.return and publish_delay_copy raises (the delivery
    is then requeued after a pause, never acknowledged as re-scheduled). Nothing is created on the broker."""
    monkeypatch.setattr(tasks, "DELAY_QUEUE", "agrotrace.django.jobs.no-such-queue")
    envelope = {"id": str(uuid.uuid4()), "type": "vsd.import", "data": {}}
    with pytest.raises(Exception, match="NO_ROUTE"):
        tasks.publish_delay_copy(_Request(envelope))
    assert "agrotrace.django.jobs.no-such-queue" not in _names("queues")
