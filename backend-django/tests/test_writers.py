"""The outbox and audit writers (infra.outbox.enqueue, core.audit.record): rows of `backend = 'django'` in the
caller's transaction, nothing left by a rollback."""

import json
import uuid

import pytest

from agrotrace.core import audit, context, sql
from agrotrace.core.tx import with_tx
from agrotrace.infra import outbox
from agrotrace.security.jwt import Principal


@pytest.fixture
def request_ctx():
    token = context.bind(context.RequestContext(request_id="req-test-1", ip="10.1.2.3"))
    yield
    context.reset(token)


def _json(v):
    return v if isinstance(v, (dict, list)) else json.loads(v)


def test_enqueue_writes_the_envelope_in_the_transaction(db, request_ctx):
    data = {"orgIds": [str(uuid.uuid4())], "kind": "TEST"}
    event_id = with_tx(lambda tx: outbox.enqueue(tx, "notification.dispatch", data))
    try:
        row = sql.one("SELECT backend, type, payload, published_at FROM outbox_events WHERE id = %s", [event_id])
        assert row["backend"] == "django" and row["type"] == "notification.dispatch" and row["published_at"] is None
        payload = _json(row["payload"])
        assert payload["id"] == event_id and payload["backend"] == "django" and payload["requestId"] == "req-test-1"
        assert payload["type"] == "notification.dispatch" and payload["data"] == data
        assert payload["occurredAt"].endswith("Z") and len(payload["occurredAt"]) == 24
    finally:
        sql.execute("DELETE FROM outbox_events WHERE id = %s", [event_id])


def test_a_rolled_back_enqueue_leaves_no_row(db, request_ctx):
    ids = []

    def fn(tx):
        ids.append(outbox.enqueue(tx, "lab.escalate", {}))
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        with_tx(fn)
    assert sql.scalar("SELECT count(*) FROM outbox_events WHERE id = %s", [ids[0]]) == 0


def test_audit_record(db, request_ctx):
    actor = Principal(user_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), roles=("ADMIN",), org_admin=False)
    entity = str(uuid.uuid4())
    diff = audit.audit_diff(None, {"name": "Поле 1", "note": None, "password": audit.SECRET})
    assert diff == {"name": [None, "Поле 1"], "password": [None, "***"]}

    seen = {}

    class Rollback(Exception):
        pass

    def fn(tx):
        audit.record(tx, action="createField", entity_type="field", entity_id=entity, diff=diff, actor=actor)
        seen["row"] = tx.one("SELECT * FROM audit_log WHERE entity_id = %s", [entity])
        seen["now"] = tx.now
        raise Rollback  # audit_log is append-only for agrotrace_app: the test leaves no row behind

    with pytest.raises(Rollback):
        with_tx(fn)
    row = seen["row"]
    assert row["backend"] == "django" and row["action"] == "createField" and row["entity_type"] == "field"
    assert str(row["actor_id"]) == actor.user_id and row["request_id"] == "req-test-1"
    assert str(row["ip"]) == "10.1.2.3" and row["created_at"] == seen["now"]  # the transaction's now() (P43)
    assert _json(row["diff"]) == diff
    assert sql.scalar("SELECT count(*) FROM audit_log WHERE entity_id = %s", [entity]) == 0
    assert audit.audit_diff({"a": 1, "b": "x"}, {"a": 1, "b": "y"}) == {"b": ["x", "y"]}
    assert audit.audit_removal({"a": 1, "b": None}) == {"a": [1, None]}
