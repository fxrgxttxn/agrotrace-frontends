"""The client IP (P9): the LAST X-Forwarded-For hop (the one the gateway appended), else the socket peer of the ASGI
scope; `::ffff:a.b.c.d` → `a.b.c.d`."""

from types import SimpleNamespace

import pytest

from agrotrace.core.ratelimit import client_ip


def req(xff=None, peer="172.20.0.5"):
    meta = {"REMOTE_ADDR": "127.0.0.1"}
    if xff is not None:
        meta["HTTP_X_FORWARDED_FOR"] = xff
    return SimpleNamespace(META=meta, scope={"client": (peer, 50000)})


@pytest.mark.parametrize(
    ("xff", "peer", "expected"),
    [
        ("203.0.113.7, 10.0.0.1", "172.20.0.5", "10.0.0.1"),
        ("10.0.0.2", "172.20.0.5", "10.0.0.2"),
        (None, "172.20.0.5", "172.20.0.5"),
        (None, "::ffff:10.0.0.1", "10.0.0.1"),
        ("::ffff:10.0.0.1", "172.20.0.5", "10.0.0.1"),
        ("10.0.0.1, not-an-ip", "172.20.0.5", "172.20.0.5"),
    ],
)
def test_client_ip(xff, peer, expected):
    assert client_ip(req(xff, peer)) == expected
