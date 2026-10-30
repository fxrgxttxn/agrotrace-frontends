"""ALTCHA v1 (P40) against the shared vector contracts/rules/altcha.json: the key, the challenge and signature recipe,
and every case's verdict at its `nowMs`; base64 is the standard padded alphabet."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from agrotrace.core import config
from agrotrace.infra import altcha

VECTOR = json.loads((config.ROOT / "contracts" / "rules" / "altcha.json").read_text("utf-8"))
KEY = VECTOR["key"]


def test_key_is_the_vector_key():
    assert altcha.key(VECTOR["jwtSecret"]) == KEY


def test_challenge_and_signature_recipe():
    ch = hashlib.sha256(f"{VECTOR['salt']}{VECTOR['number']}".encode()).hexdigest()
    assert ch == VECTOR["challenge"]
    assert hmac.new(KEY.encode("utf-8"), ch.encode(), hashlib.sha256).hexdigest() == VECTOR["signature"]


@pytest.mark.parametrize("case", VECTOR["cases"], ids=[c["name"] for c in VECTOR["cases"]])
def test_vector_case(case):
    got = altcha.verify(case["payload"], case["nowMs"], hmac_key=KEY)
    assert (got is not None) == case["valid"]
    if case["valid"]:
        assert got == VECTOR["signature"]


def _encode(obj) -> str:
    return base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")


def _solve(c: dict) -> int:
    for n in range(c["maxnumber"] + 1):
        if hashlib.sha256(f"{c['salt']}{n}".encode()).hexdigest() == c["challenge"]:
            return n
    raise AssertionError("unsolvable")


def test_issued_challenge_is_solvable_and_expires_after_600_s():
    now_ms = 1_790_243_700_123
    c = altcha.challenge(now_ms, hmac_key=KEY)
    assert c["algorithm"] == "SHA-256" and c["maxnumber"] == 100_000
    hex_part, expires = c["salt"].split("?expires=")
    assert len(hex_part) == 24 and int(expires) == now_ms // 1000 + 600
    assert c["signature"] == hmac.new(KEY.encode(), c["challenge"].encode(), hashlib.sha256).hexdigest()
    sol = {"algorithm": "SHA-256", "challenge": c["challenge"], "number": _solve(c), "salt": c["salt"],
           "signature": c["signature"]}
    payload = _encode(sol)
    assert altcha.verify(payload, int(expires) * 1000, hmac_key=KEY) == c["signature"]
    assert altcha.verify(payload, int(expires) * 1000 + 1, hmac_key=KEY) is None
    # Another key, a trailing newline (JS `$`), a negative or unsafe number, NaN anywhere, a non-object.
    assert altcha.verify(payload, now_ms, hmac_key=altcha.key("another-secret")) is None
    assert altcha.verify(payload + "\n", now_ms, hmac_key=KEY) is None
    assert altcha.verify(_encode({**sol, "number": -1}), now_ms, hmac_key=KEY) is None
    assert altcha.verify(_encode({**sol, "number": 2**53}), now_ms, hmac_key=KEY) is None
    nan = base64.b64encode(json.dumps(sol)[:-1].encode() + b',"x":NaN}').decode()
    assert altcha.verify(nan, now_ms, hmac_key=KEY) is None
    assert altcha.verify(_encode({**sol, "salt": c["salt"] + "\n"}), now_ms, hmac_key=KEY) is None
    assert altcha.verify(_encode([sol]), now_ms, hmac_key=KEY) is None
