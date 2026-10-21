"""core.tx.with_tx on agrotrace_test_django: isolation, one retry of 40P01/40001 and of `retry_if`, the single
`now()` of a transaction (P43), and no nesting."""

import uuid

import psycopg
import pytest
from django.db import IntegrityError, transaction

from agrotrace.core.problem import AppProblem
from agrotrace.core.tx import RECALL_TX, is_unique_violation, with_tx
from tests.test_problem import wrapped


def test_repeatable_read_sees_its_snapshot(db, other_session):
    marker = str(uuid.uuid4())
    seen = []

    def fn(tx):
        seen.append(tx.scalar("SELECT count(*) FROM processed_events WHERE event_id = %s", [marker]))
        other_session.execute("INSERT INTO processed_events (event_id, backend) VALUES (%s, 'django')", [marker])
        seen.append(tx.scalar("SELECT count(*) FROM processed_events WHERE event_id = %s", [marker]))

    try:
        with_tx(fn, isolation="repeatable read")
        assert seen == [0, 0]
        seen.clear()
        with_tx(lambda tx: seen.append(tx.scalar("SELECT count(*) FROM processed_events WHERE event_id = %s",
                                                 [marker])))
        assert seen == [1]
    finally:
        other_session.execute("DELETE FROM processed_events WHERE event_id = %s", [marker])


def test_read_committed_by_default_and_read_only(db):
    assert with_tx(lambda tx: tx.scalar("SHOW transaction_isolation")) == "read committed"
    assert with_tx(lambda tx: tx.scalar("SHOW transaction_isolation"), isolation="repeatable read") == \
        "repeatable read"
    assert with_tx(lambda tx: tx.scalar("SHOW transaction_read_only"), isolation="read only repeatable read") == "on"


def test_a_deadlock_on_the_first_attempt_is_retried_and_now_is_one_instant(db):
    calls = []

    def fn(tx):
        calls.append(1)
        a = tx.scalar("SELECT now()")
        tx.scalar("SELECT pg_sleep(0.02)")
        b = tx.scalar("SELECT now()")
        clock = tx.scalar("SELECT clock_timestamp()")
        assert a == b == tx.now and clock > a
        if len(calls) == 1:
            raise wrapped(psycopg.errors.DeadlockDetected("deadlock detected"))
        return "done"

    assert with_tx(fn) == "done"
    assert len(calls) == 2


def test_retry_once_false(db):
    calls = []

    def fn(tx):
        calls.append(1)
        raise wrapped(psycopg.errors.SerializationFailure("could not serialize"))

    with pytest.raises(AppProblem):
        with_tx(fn, retry_once=False)
    assert calls == [1]


def test_a_nested_call_is_a_programmers_error(db):
    with transaction.atomic(), pytest.raises(AssertionError):
        with_tx(lambda tx: None)


def _duplicate(tx, index_name: str):
    tx.execute("CREATE TEMP TABLE t_recall (source uuid) ON COMMIT DROP")
    tx.execute(f"CREATE UNIQUE INDEX {index_name} ON pg_temp.t_recall (source)")
    v = str(uuid.uuid4())
    tx.execute("INSERT INTO t_recall VALUES (%s)", [v])
    tx.execute("INSERT INTO t_recall VALUES (%s)", [v])  # 23505 on index_name


def test_retry_if_on_the_open_recall_index_retries_once_then_409_with_conflict_params(db):
    calls, params_calls = [], []

    def fn(tx):
        calls.append(1)
        _duplicate(tx, "ux_recalls_open_source")

    def conflict_params():
        params_calls.append(1)
        return {"currentVersion": 3}

    with pytest.raises(AppProblem) as e:
        with_tx(fn, conflict_params=conflict_params, **RECALL_TX)
    assert len(calls) == 2 and len(params_calls) == 1
    assert (e.value.status, e.value.code, e.value.params) == (409, "VERSION_CONFLICT", {"currentVersion": 3})

    calls.clear()

    def once(tx):
        calls.append(1)
        if len(calls) == 1:
            _duplicate(tx, "ux_recalls_open_source")
        return tx.scalar("SHOW transaction_isolation")

    assert with_tx(once, **RECALL_TX) == "repeatable read"
    assert len(calls) == 2


def test_a_unique_violation_of_another_index_is_not_retried(db):
    calls = []

    def fn(tx):
        calls.append(1)
        _duplicate(tx, "ux_other_thing")

    with pytest.raises(IntegrityError) as e:
        with_tx(fn, **RECALL_TX)
    assert calls == [1]
    assert not is_unique_violation("ux_recalls_open_source")(e.value)
    assert is_unique_violation("ux_other_thing")(e.value)


def test_on_commit_runs_only_after_a_commit(db):
    ran = []
    attempts = []

    def fn(tx):
        attempts.append(1)
        tx.on_commit(lambda: ran.append(len(attempts)))
        if len(attempts) == 1:
            raise wrapped(psycopg.errors.DeadlockDetected("deadlock detected"))

    with_tx(fn)
    assert ran == [2]  # only the committed second attempt's callback ran


def test_lock_is_no_key_update_in_id_order(db, other_session):
    from agrotrace.core.locks import lock
    from agrotrace.core.models import ProcessedEvent

    ids = sorted(str(uuid.uuid4()) for _ in range(2))
    for i in ids:
        other_session.execute("INSERT INTO processed_events (event_id, backend) VALUES (%s, 'django')", [i])
    seen = {}

    def fn(tx):
        rows = lock(ProcessedEvent, reversed(ids))
        seen["ids"] = [str(r.event_id) for r in rows]
        # FOR KEY SHARE (a referencing insert) is not blocked by FOR NO KEY UPDATE; FOR UPDATE would be.
        other_session.execute("SELECT 1 FROM processed_events WHERE event_id = %s FOR KEY SHARE NOWAIT", [ids[0]])
        try:
            other_session.execute("SELECT 1 FROM processed_events WHERE event_id = %s FOR NO KEY UPDATE NOWAIT",
                                  [ids[0]])
            seen["blocked"] = False
        except psycopg.errors.LockNotAvailable:
            seen["blocked"] = True

    try:
        with_tx(fn)
        assert seen == {"ids": ids, "blocked": True}
        with pytest.raises(AssertionError):
            lock(ProcessedEvent, ids)  # outside a transaction
    finally:
        other_session.execute("DELETE FROM processed_events WHERE event_id = ANY(%s::uuid[])", [ids])
