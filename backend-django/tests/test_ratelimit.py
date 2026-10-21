"""Rate limits (R30, P10): the key `rl:{scope}:{subject}:{windowStart}`, INCR + EXPIRE … NX in one MULTI, Retry-After
to the window end, params {scope, limit, windowSec}; RATE_LIMIT_OVERRIDES replace only the limit."""

import dataclasses

import pytest

from agrotrace.core import config, ratelimit
from agrotrace.core.problem import AppProblem


class FakePipe:
    def __init__(self, store, log, transaction):
        self.store, self.log, self.transaction, self.ops = store, log, transaction, []

    def incr(self, key):
        self.ops.append(("incr", key))

    def expire(self, key, ttl, nx=False):
        self.ops.append(("expire", key, ttl, nx))

    def execute(self):
        self.log.append((self.transaction, list(self.ops)))
        out = []
        for op in self.ops:
            if op[0] == "incr":
                self.store[op[1]] = self.store.get(op[1], 0) + 1
                out.append(self.store[op[1]])
            else:
                out.append(True)
        return out


class FakeRedis:
    def __init__(self):
        self.store, self.log = {}, []

    def pipeline(self, transaction=True):
        return FakePipe(self.store, self.log, transaction)


@pytest.fixture
def fake(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr("agrotrace.infra.redis.client", lambda: r)
    return r


def test_key_multi_and_429(fake):
    now = 1_790_000_017.4  # the 60 s window starts at 1789999980 and ends in 23 s
    lim = ratelimit.limit_of("login-ip")
    for _ in range(lim.limit):
        ratelimit.hit("login-ip", "10.1.2.3", now=now)
    key = "rl:login-ip:10.1.2.3:1789999980"
    assert fake.log[0] == (True, [("incr", key), ("expire", key, 60, True)])
    with pytest.raises(AppProblem) as e:
        ratelimit.hit("login-ip", "10.1.2.3", now=now)
    assert e.value.status == 429 and e.value.code == "RATE_LIMITED"
    assert e.value.params == {"scope": "login-ip", "limit": lim.limit, "windowSec": 60}
    assert e.value.headers == {"Retry-After": "23"}


def test_retry_after_is_at_least_one(fake):
    lim = ratelimit.limit_of("forgot")
    now = 1_790_002_799.9  # one hour window ending at 1790002800
    for _ in range(lim.limit):
        ratelimit.hit("forgot", "a@b.ru", now=now)
    with pytest.raises(AppProblem) as e:
        ratelimit.hit("forgot", "a@b.ru", now=now)
    assert e.value.headers == {"Retry-After": "1"}


def test_overrides_change_only_the_limit(monkeypatch):
    base = ratelimit.limit_of("user")
    cfg = dataclasses.replace(config.get(), RATE_LIMIT_OVERRIDES={"user": 3})
    monkeypatch.setattr(config, "get", lambda: cfg)
    over = ratelimit.limit_of("user")
    assert (over.limit, over.window_sec, over.subject) == (3, base.window_sec, base.subject)
