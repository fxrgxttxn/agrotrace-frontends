"""
JSON bodies as express.json reads them (core.body + the middleware before routing), over the real ASGI application:
a malformed body is 400 `_root` even on an operation that is not implemented yet, an oversized one 413.
"""

import pytest

from agrotrace.core.body import decode_json_bytes, js_json_parse
from agrotrace.core.problem import AppProblem
from agrotrace.core.validation import ContractSerializer, NameString
from tests.asgi_client import call, run

JSON = {"content-type": "application/json"}


def post(body: bytes, headers=None):
    return run(call("POST", "/api/v1/auth/login", headers={**JSON, **(headers or {})}, body=body))


@pytest.mark.parametrize("body", [b'{"a": NaN}', b'{"a": Infinity}', b'{"a": -Infinity}', b'{"email": "a@b.ru", ',
                                  b'"just a string"', b"42", b"   ", b"{'a': 1}"])
def test_unreadable_json_is_root_invalid(body):
    r = post(body)
    assert r.status == 400
    assert r.headers["content-type"] == "application/problem+json"
    assert r.json()["errors"] == {"_root": ["validation.invalid"]}
    assert r.headers["x-backend"] == "django"


def test_a_foreign_charset_is_root_invalid():
    r = post(b'{"a": 1}', {"content-type": "application/json; charset=latin1"})
    assert (r.status, r.json()["errors"]) == (400, {"_root": ["validation.invalid"]})


def test_utf8_charset_and_problem_json_type_are_read():
    # A readable body reaches the view: login's schema reports the unknown key `a` (and the missing fields).
    for ct in ("application/json; charset=UTF-8", "application/merge-patch+json"):
        r = post(b'{"a": 1}', {"content-type": ct})
        assert r.status == 400 and r.json()["errors"]["a"] == ["validation.unknownField"]


def test_a_body_over_12_mib_is_413_with_max_bytes():
    r = post(b"x" * (12 * 1024 * 1024 + 1))
    assert r.status == 413
    assert r.json()["code"] == "FILE_TOO_LARGE"
    assert r.json()["params"] == {"maxBytes": 12582912}


def test_an_array_instead_of_an_object_is_root_type():
    class Login(ContractSerializer):
        email = NameString()

    data = decode_json_bytes(b"[1]", "application/json")
    with pytest.raises(AppProblem) as e:
        Login.parse_body(data)
    assert e.value.errors == {"_root": ["validation.type"]}


def test_js_numbers():
    assert js_json_parse('{"a": 5.0, "b": 1e2, "c": 1.5, "d": 9007199254740993}') == {
        "a": 5, "b": 100, "c": 1.5, "d": 9007199254740992.0}
    assert type(js_json_parse("5.0")) is int


def test_invalid_utf8_is_replaced_and_bom_dropped():
    assert decode_json_bytes(b'\xef\xbb\xbf{"a": "\xff"}', "application/json") == {"a": "�"}
