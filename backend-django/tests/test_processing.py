"""processBatches paths that HTTP cannot reach (P55): a deadlock on both attempts is 409 VERSION_CONFLICT without
params (contract 409 `lockRetryFailed`), a deadlock on the first attempt only is retried with the whole transaction;
and the mass never passes through a float."""

import inspect
import uuid

import psycopg
import pytest

from agrotrace.core.problem import AppProblem
from agrotrace.modules.processing import services
from agrotrace.security.jwt import Principal
from tests.test_problem import wrapped

P = Principal(user_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), roles=("PROCESSOR",), org_admin=False)
BODY = {"inputs": [{"batchId": str(uuid.uuid4()), "massUsedKg": "10.000"}],
        "outputs": [{"productId": str(uuid.uuid4()), "massKg": "1.000"}]}


def test_a_second_deadlock_is_409_version_conflict_without_params(db, monkeypatch):
    calls = []

    def deadlock(tx, ids):
        calls.append(ids)
        raise wrapped(psycopg.errors.DeadlockDetected("deadlock detected"))

    monkeypatch.setattr(services, "lock_inputs", deadlock)
    with pytest.raises(AppProblem) as e:
        services.process(P, BODY)
    assert (e.value.status, e.value.code, e.value.params) == (409, "VERSION_CONFLICT", None)
    assert len(calls) == 2  # one retry of the whole transaction, then the conflict


def test_a_first_deadlock_is_retried_and_the_checks_run_again(db, monkeypatch):
    calls = []
    real = services.lock_inputs

    def once(tx, ids):
        calls.append(ids)
        if len(calls) == 1:
            raise wrapped(psycopg.errors.DeadlockDetected("deadlock detected"))
        return real(tx, ids)

    monkeypatch.setattr(services, "lock_inputs", once)
    with pytest.raises(AppProblem) as e:
        services.process(P, BODY)  # the retry runs step 2 over the (empty) locked rows
    assert (e.value.status, e.value.code) == (400, "VALIDATION")
    assert e.value.errors == {"inputs[0].batchId": ["validation.notFound"],
                              "outputs[0].productId": ["validation.notFound"]}
    assert len(calls) == 2


def test_the_mass_never_passes_through_a_float():
    """The service and the domain modules that do its arithmetic (check_mass_balance, kg_to_grams, mass_total, the
    loss-norm basis points) — Task 8 review M2."""
    from agrotrace.domain import decimal, rules

    for module in (services, rules, decimal):
        src = inspect.getsource(module)
        assert "float(" not in src, module.__name__


def test_a_repeated_input_in_another_letter_case_is_the_step_1_duplicate():
    from agrotrace.modules.processing.serializers import ProcessingRequest

    bid = str(uuid.uuid4())
    ok, _value, errors = ProcessingRequest.validate({
        "inputs": [{"batchId": bid, "massUsedKg": "1.000"}, {"batchId": bid.upper(), "massUsedKg": "2.000"},
                   {"batchId": str(uuid.uuid4()), "massUsedKg": "1.000"}],
        "outputs": [{"productId": str(uuid.uuid4()), "massKg": "1.000"}, {"productId": str(uuid.uuid4()),
                                                                         "massKg": "1.000"}]})
    assert not ok
    assert errors == {"inputs[1].batchId": ["validation.duplicate"]}
    # Products of the outputs may repeat.
    pid = str(uuid.uuid4())
    ok, _value, errors = ProcessingRequest.validate({
        "inputs": [{"batchId": bid, "massUsedKg": "1.000"}],
        "outputs": [{"productId": pid, "massKg": "1.000"}, {"productId": pid.upper(), "massKg": "1.000"}]})
    assert ok, errors


def test_a_malformed_id_in_another_letter_case_is_not_a_duplicate():
    """Task 8 review M1: only valid uuids are folded; other strings are compared as Zod compares them, so the 400 of
    a malformed id is Express's (`validation.uuid` alone)."""
    from agrotrace.modules.processing.serializers import ProcessingRequest

    out = [{"productId": str(uuid.uuid4()), "massKg": "1.000"}]
    ok, _value, errors = ProcessingRequest.validate({
        "inputs": [{"batchId": "abc", "massUsedKg": "1.000"}, {"batchId": "ABC", "massUsedKg": "1.000"}],
        "outputs": out})
    assert not ok
    assert errors == {"inputs[0].batchId": ["validation.uuid"], "inputs[1].batchId": ["validation.uuid"]}
    # The same malformed string twice is a duplicate, as in Zod.
    ok, _value, errors = ProcessingRequest.validate({
        "inputs": [{"batchId": "abc", "massUsedKg": "1.000"}, {"batchId": "abc", "massUsedKg": "1.000"}],
        "outputs": out})
    assert errors == {"inputs[0].batchId": ["validation.uuid"],
                      "inputs[1].batchId": ["validation.uuid", "validation.duplicate"]}
