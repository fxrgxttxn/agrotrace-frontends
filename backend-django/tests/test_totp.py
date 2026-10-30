"""TOTP (R35): RFC 6238 vectors (SHA1, truncated to 6 digits, 30 s), the ±1 step window and otplib's keyuri."""

import base64

import pytest

from agrotrace.security import totp

#: RFC 6238 Appendix B, SHA1 seed "12345678901234567890" (8-digit codes; the 6-digit code is their last 6 digits).
RFC_SECRET = base64.b32encode(b"12345678901234567890").decode()
VECTORS = [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"), (1234567890, "89005924"),
           (2000000000, "69279037"), (20000000000, "65353130")]


@pytest.mark.parametrize(("t", "code8"), VECTORS)
def test_rfc_6238_vectors(t, code8):
    assert totp.code_at(RFC_SECRET, t // 30) == code8[-6:]
    assert totp.verify(RFC_SECRET, code8[-6:], t) == t // 30


def test_window_is_plus_minus_one_step():
    t = 1_790_000_000
    s = t // 30
    for delta in (-1, 0, 1):
        assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, s + delta), t) == s + delta
    for delta in (-2, 2):
        code = totp.code_at(RFC_SECRET, s + delta)
        if code not in {totp.code_at(RFC_SECRET, s + d) for d in (-1, 0, 1)}:
            assert totp.verify(RFC_SECRET, code, t) is None


def test_otplib_vector():
    # otplib: authenticator.clone({step: 30, digits: 6}).clone({epoch: 1790000000000}).generate(secret)
    assert totp.code_at("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", 1_790_000_000 // 30) == "739342"


def test_keyuri_is_otplibs():
    assert totp.otpauth_url("user.x+1@agrotrace.test", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") == (
        "otpauth://totp/AgroTrace:user.x%2B1%40agrotrace.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
        "&period=30&digits=6&algorithm=SHA1&issuer=AgroTrace"
    )


def test_secret_shape():
    s = totp.generate_secret()
    assert len(s) == 32 and set(s) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
