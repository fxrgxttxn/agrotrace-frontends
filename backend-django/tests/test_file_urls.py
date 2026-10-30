"""Signed file URLs (R28/R39/R88, P17, D-M11): the signature equals backend-express/src/infra/file-urls.ts for a fixed
vector (key = the RAW bytes of HMAC(JWT_SECRET, "agrotrace:file-url:v1"), id lower-cased); expired, upper-case or
short `sig` and any `exp` not matching ^[1-9]\\d{0,11}$ are refused."""

import pytest

from agrotrace.infra import file_urls

SECRET = "test_secret_of_at_least_32_bytes_long!!"
ID = "8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e"
#: createHmac('sha256', createHmac('sha256', SECRET).update('agrotrace:file-url:v1').digest())
#:   .update(`${ID}:1790000000`).digest('hex') — run under backend-express.
EXPRESS_SIG = "7cbbb5c69c74c3fb777dbfd3c4d4904049f0f0c19080b19c31e194f92123ef64"


def test_the_express_vector():
    assert file_urls.signature(ID, 1_790_000_000, SECRET) == EXPRESS_SIG
    assert file_urls.signature(ID.upper(), 1_790_000_000, SECRET) == EXPRESS_SIG


def test_signed_and_verified():
    url = file_urls.signed(ID.upper(), now=1_790_000_000)
    exp = 1_790_000_000 + 3600
    assert url == f"/api/v1/files/{ID}?exp={exp}&sig={file_urls.signature(ID, exp)}"
    assert file_urls.verify(ID, str(exp), file_urls.signature(ID, exp), now=1_790_000_000)
    assert file_urls.verify(ID, str(exp), file_urls.signature(ID, exp), now=exp)  # exp == now still valid


def test_refused():
    exp = 1_790_003_600
    sig = file_urls.signature(ID, exp)
    now = 1_790_000_000
    assert not file_urls.verify(ID, str(exp), sig, now=exp + 1)  # expired
    assert not file_urls.verify(ID, str(exp), sig.upper(), now=now)
    assert not file_urls.verify(ID, str(exp), sig[:63], now=now)
    assert not file_urls.verify(ID, str(exp + 1), sig, now=now)


@pytest.mark.parametrize("exp", ["0", "01790003600", "+1790003600", "1" * 13, "1790003600.0", " 1790003600", ""])
def test_exp_must_be_exactly_as_issued(exp):
    assert not file_urls.verify(ID, exp, file_urls.signature(ID, 1_790_003_600), now=0)
