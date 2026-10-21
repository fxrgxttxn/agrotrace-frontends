"""Access tokens (P12): a token in Express's format (jose SignJWT) is accepted; every claim-type and header deviation is
refused; iat in the future is accepted (as jose); exp <= now has expired."""

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime

import pytest

from agrotrace.core import config
from agrotrace.security.jwt import ACCESS_TTL_SEC, Principal, issue_access_token, verify_access_token


def b64(obj) -> str:
    raw = obj if isinstance(obj, bytes) else json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign(payload, header=None, alg="sha256", secret=None) -> str:
    head = b64(header or {"alg": "HS256", "typ": "JWT"})
    body = b64(payload)
    key = (secret or config.get().JWT_SECRET).encode()
    sig = hmac.new(key, f"{head}.{body}".encode(), getattr(hashlib, alg)).digest()
    return f"{head}.{body}.{b64(sig)}"


def claims(**over):
    now = int(time.time())
    base = {"org": str(uuid.uuid4()), "roles": ["FARMER"], "org_admin": True, "sub": str(uuid.uuid4()),
            "iat": now, "exp": now + 900, "jti": str(uuid.uuid4())}
    base.update(over)
    return {k: v for k, v in base.items() if v is not ...}


def test_an_express_format_token_is_accepted():
    c = claims()
    verified = verify_access_token(sign(c))
    assert verified is not None
    p, exp = verified
    assert p == Principal(c["sub"], c["org"], ("FARMER",), True) and exp == c["exp"]


def test_issued_tokens_have_the_express_header_and_claims():
    p = Principal(str(uuid.uuid4()), str(uuid.uuid4()), ("INSPECTOR",), False)
    now = datetime.fromtimestamp(time.time(), UTC)
    token = issue_access_token(p, now)
    head, body, _ = token.split(".")
    assert json.loads(base64.urlsafe_b64decode(head + "==")) == {"alg": "HS256", "typ": "JWT"}
    payload = json.loads(base64.urlsafe_b64decode(body + "=="))
    assert payload["sub"] == p.user_id and payload["org"] == p.org_id and payload["roles"] == ["INSPECTOR"]
    assert payload["org_admin"] is False and payload["exp"] - payload["iat"] == ACCESS_TTL_SEC
    assert isinstance(payload["jti"], str)
    assert verify_access_token(token)[0] == p


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(lambda: b64({"alg": "none", "typ": "JWT"}) + "." + b64(claims()) + ".", id="alg none"),
        pytest.param(lambda: sign(claims(), {"alg": "HS512", "typ": "JWT"}, "sha512"), id="HS512"),
        pytest.param(lambda: sign(claims(), {"alg": "HS256", "typ": "JWT", "crit": ["x-at"], "x-at": 1}),
                     id="unknown crit"),
        pytest.param(lambda: sign(claims(roles=[])), id="roles empty"),
        pytest.param(lambda: sign(claims(roles=["ROOT"])), id="unknown role"),
        pytest.param(lambda: sign(claims(org_admin="true")), id="org_admin string"),
        pytest.param(lambda: sign(claims(exp=int(time.time()) + 900.5)), id="exp fractional"),
        pytest.param(lambda: sign(claims(sub="admin")), id="sub not uuid"),
        pytest.param(lambda: sign(claims(org=42)), id="org not uuid"),
        pytest.param(lambda: sign(claims(jti=7)), id="jti not string"),
        pytest.param(lambda: sign(claims(jti=...)), id="no jti"),
        pytest.param(lambda: sign(claims(iat=...)), id="no iat"),
        pytest.param(lambda: sign(claims(), secret="another_secret_of_at_least_32_bytes!!"), id="foreign key"),
        pytest.param(lambda: sign(claims(exp=int(time.time()))), id="exp == now"),
        pytest.param(lambda: sign(claims(iat=int(time.time()) - 1000, exp=int(time.time()) - 1)), id="expired"),
    ],
)
def test_refused(token):
    assert verify_access_token(token()) is None


def test_iat_in_the_future_is_accepted_like_jose():
    now = int(time.time())
    assert verify_access_token(sign(claims(iat=now + 3600, exp=now + 900))) is not None


def test_an_integral_float_exp_is_an_integer():
    now = int(time.time())
    assert verify_access_token(sign(claims(exp=float(now + 900)))) is not None
