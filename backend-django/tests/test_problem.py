"""
core.problem: every error becomes a problem of the contract's `Problem` schema (validated against the bundle);
P61 infrastructure failures are 503 BACKEND_UNAVAILABLE; DRF's and Django's own error output never leaks.
"""

import json

import jsonschema
import psycopg
import pytest
from django.db import utils as dbutils
from psycopg_pool import PoolTimeout
from rest_framework import exceptions as drf

from agrotrace.core import contract
from agrotrace.core.problem import AppProblem, exception_handler, handler404, handler500, problem_type
from agrotrace.core.tx import with_tx


def problem_schema_validator():
    doc = contract.load().doc
    return jsonschema.Draft202012Validator({"$ref": "#/components/schemas/Problem", "components": doc["components"]})


def render(exc):
    res = exception_handler(exc, {})
    body = json.loads(res.content)
    problem_schema_validator().validate(body)
    assert res["Content-Type"] == "application/problem+json"
    assert body["status"] == res.status_code
    assert body["type"] == problem_type(body["code"])
    return res.status_code, body


def wrapped(cause: Exception) -> Exception:
    """A psycopg error as Django raises it (django.db.utils.* with __cause__)."""
    try:
        try:
            raise cause
        except Exception as e:
            raise dbutils.OperationalError(str(e)) from e
    except dbutils.OperationalError as outer:
        return outer


@pytest.mark.parametrize(
    "exc",
    [
        wrapped(PoolTimeout("couldn't get a connection after 5.00 sec")),
        PoolTimeout("couldn't get a connection after 5.00 sec"),
        wrapped(psycopg.errors.QueryCanceled("canceling statement due to statement timeout")),
        wrapped(psycopg.errors.LockNotAvailable("canceling statement due to lock timeout")),
    ],
)
def test_backend_unavailable(exc):
    assert render(exc) == (503, {"type": "/problems/backend-unavailable", "title": "Backend unavailable",
                                 "status": 503, "code": "BACKEND_UNAVAILABLE"})


def test_unknown_error_is_500_internal_without_internals():
    status, body = render(RuntimeError("secret internals at line 42"))
    assert status == 500
    assert body == {"type": "/problems/internal", "title": "Internal server error", "status": 500,
                    "code": "INTERNAL"}


def test_drf_errors_are_contract_problems():
    assert render(drf.NotAuthenticated())[0] == 401
    assert render(drf.AuthenticationFailed())[1]["code"] == "UNAUTHORIZED"
    assert render(drf.PermissionDenied())[1]["code"] == "FORBIDDEN"
    status, body = render(drf.ParseError("JSON parse error"))
    assert (status, body["errors"]) == (400, {"_root": ["validation.invalid"]})


def test_app_problem_with_everything():
    p = AppProblem(422, "BUSINESS_RULE", rule="BR-01", params={"until": "2026-10-01"},
                   headers={"Retry-After": "3"})
    res = exception_handler(p, {})
    assert res["Retry-After"] == "3"
    assert json.loads(res.content) == {"type": "/problems/business-rule", "title": "Business rule violated",
                                       "status": 422, "code": "BUSINESS_RULE", "rule": "BR-01",
                                       "params": {"until": "2026-10-01"}}


def test_django_handlers():
    res = handler404(None)
    assert res.status_code == 404 and json.loads(res.content)["code"] == "NOT_FOUND"
    res = handler500(None)
    assert res.status_code == 500 and json.loads(res.content)["code"] == "INTERNAL"


def test_a_deadlock_twice_is_409_version_conflict(db):
    calls = []

    def fn(tx):
        calls.append(1)
        tx.scalar("SELECT 1")
        raise wrapped(psycopg.errors.DeadlockDetected("deadlock detected"))

    with pytest.raises(AppProblem) as e:
        with_tx(fn)
    assert len(calls) == 2
    status, body = render(e.value)
    assert (status, body["code"]) == (409, "VERSION_CONFLICT")
    assert "params" not in body
