"""The Telegram poller (infra/telegram.py; contract shared Redis keys `tg:poller`, `tgcode:{code}`): `SET NX EX 30`,
renewal every 10 s by the contract's Lua compare-and-PEXPIRE, 0 → polling stops (a poll in flight is dropped), the
offset moves only past handled updates, `/start <code>` → `GETDEL tgcode:{code}` → users.telegram_chat_id; the
Bot API client's request shapes."""

from __future__ import annotations

import json
import threading
import time

import pytest

from agrotrace.core import sql
from agrotrace.infra import telegram
from agrotrace.infra.telegram import POLLER_KEY, RENEW, Poller, Telegram
from tests.world import World

CONTRACT_RENEW = ("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 30000) end "
                  "return 0")


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.ttl: dict[str, int] = {}
        self.calls: list[tuple] = []
        self.lock = threading.Lock()

    def set(self, key, value, nx=False, ex=None):
        with self.lock:
            self.calls.append(("set", key, value, nx, ex))
            if nx and key in self.data:
                return None
            self.data[key] = value
            self.ttl[key] = ex * 1000
            return True

    def eval(self, script, numkeys, key, arg):
        with self.lock:
            self.calls.append(("eval", script, numkeys, key, arg))
            if self.data.get(key) != arg:
                return 0
            if "PEXPIRE" in script:
                self.ttl[key] = 30000
                return 1
            del self.data[key]
            return 1

    def getdel(self, key):
        with self.lock:
            self.calls.append(("getdel", key))
            v = self.data.pop(key, None)
            return None if v is None else v.encode()


class FakeTelegram(Telegram):
    def __init__(self, batches: list[list[dict]], *, on_poll=None) -> None:
        super().__init__("token")
        self.batches = batches
        self.offsets: list[int | None] = []
        self.on_poll = on_poll

    def get_updates(self, offset, timeout_sec=25):
        self.offsets.append(offset)
        if self.on_poll:
            self.on_poll(len(self.offsets))
        return self.batches.pop(0) if self.batches else []


def _until(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < end, "condition not reached"
        time.sleep(0.01)


def test_the_renewal_script_is_the_contracts():
    assert RENEW == CONTRACT_RENEW
    assert telegram.POLLER_TTL_S == 30 and telegram.RENEW_EVERY_S == 10


def test_only_the_key_holder_polls_and_the_key_is_taken_with_set_nx_ex_30():
    r = FakeRedis()
    r.data[POLLER_KEY] = "someone-else"
    tg = FakeTelegram([])
    p = Poller(tg, r, idle_s=0.02, min_poll_s=0.01).start()
    try:
        _until(lambda: sum(1 for c in r.calls if c[0] == "set") >= 2)
        assert tg.offsets == []
        assert r.calls[0] == ("set", POLLER_KEY, p.instance, True, 30)
        del r.data[POLLER_KEY]  # the other owner's key expired
        _until(lambda: len(tg.offsets) >= 1)
        assert r.data[POLLER_KEY] == p.instance
    finally:
        p.stop()
    assert POLLER_KEY not in r.data  # handed over at once on stop


def test_renewal_every_10_s_and_0_stops_polling(monkeypatch):
    r = FakeRedis()
    tg = FakeTelegram([])
    p = Poller(tg, r, idle_s=5, renew_every_s=0.05, min_poll_s=0.01).start()
    try:
        _until(lambda: any(c[0] == "eval" and c[1] == RENEW for c in r.calls))
        renewal = next(c for c in r.calls if c[0] == "eval")
        assert renewal == ("eval", RENEW, 1, POLLER_KEY, p.instance)
        r.data[POLLER_KEY] = "thief"  # ownership lost
        _until(lambda: not p._owner.is_set())
        polls = len(tg.offsets)
        time.sleep(0.2)
        assert len(tg.offsets) <= polls + 1  # at most the poll in flight; then no more polling
    finally:
        p.stop()
    assert r.data[POLLER_KEY] == "thief"  # never released a key that is not ours
    assert Poller(Telegram(None), r).run() is None  # no token: no poller at all


def test_a_poll_in_flight_when_ownership_is_lost_is_dropped():
    r = FakeRedis()
    p = Poller(FakeTelegram([]), r)
    p._owner.set()
    linked = []
    p.link = lambda code, chat: linked.append(code) or True
    p.telegram = FakeTelegram([[{"update_id": 7, "message": {"text": "/start abc", "chat": {"id": 1}}}]],
                              on_poll=lambda n: p._owner.clear())
    p.poll_once()
    assert linked == [] and p.offset is None


def test_the_offset_moves_only_past_handled_updates():
    r = FakeRedis()
    p = Poller(FakeTelegram([]), r)
    handled = []

    def link(code, chat):
        if code == "boom":
            raise RuntimeError("db down")
        handled.append((code, chat))
        return True

    p.link = link
    updates = [{"update_id": 10, "message": {"text": "/start code1", "chat": {"id": 555}}},
               {"update_id": 11, "message": {"text": "hello"}},
               {"update_id": 12, "message": {"text": "/start boom", "chat": {"id": 556}}},
               {"update_id": 13, "message": {"text": "/start late", "chat": {"id": 557}}}]
    with pytest.raises(RuntimeError):
        p.handle(updates)
    assert handled == [("code1", "555")]
    assert p.offset == 12  # past 10 and 11; 12 failed and is seen again
    p.handle([{"update_id": 12, "message": {"text": "/start@agrotrace_bot  again ", "chat": {"id": 556}}}])
    assert p.offset == 13 and handled[-1] == ("again", "556")


def test_the_loop_sends_the_offset_to_telegram(monkeypatch):
    r = FakeRedis()
    tg = FakeTelegram([[{"update_id": 41, "message": {"text": "x"}}], []])
    p = Poller(tg, r, idle_s=0.02, min_poll_s=0.01).start()
    try:
        _until(lambda: len(tg.offsets) >= 3)
    finally:
        p.stop()
    assert tg.offsets[:3] == [None, 42, 42]


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def test_start_code_links_the_chat_with_getdel(world):
    uid = world.user(world.org("FARM"))
    r = FakeRedis()
    r.data["tgcode:K1"] = json.dumps({"userId": uid})
    assert telegram.link_by_code("K1", "777001", redis_client=r) is True
    assert ("getdel", "tgcode:K1") in r.calls and "tgcode:K1" not in r.data
    assert sql.scalar("SELECT telegram_chat_id::text FROM users WHERE id = %s", [uid]) == "777001"
    assert telegram.link_by_code("K1", "777002", redis_client=r) is False  # one-time
    r.data["tgcode:K2"] = "not json"
    assert telegram.link_by_code("K2", "1", redis_client=r) is False


class FakeConn:
    """An http.client connection stand-in: records the request, answers `answer`, or blocks until its socket is shut
    down (`block`)."""

    def __init__(self, seen, answer=(200, {"ok": True, "result": [{"update_id": 1}]}), block=False):
        self.seen, self.answer, self.block = seen, answer, block
        self.gone = threading.Event()
        test = self

        class Sock:
            def shutdown(self, how):
                test.gone.set()

        self.sock = Sock()

    def request(self, method, path, body=None, headers=None):
        self.seen.append((method, path, json.loads(body), headers))

    def getresponse(self):
        if self.block:
            assert self.gone.wait(5), "never aborted"
            raise OSError("connection shut down")
        status, doc = self.answer
        return type("R", (), {"status": status, "read": lambda self: json.dumps(doc).encode()})()

    def close(self):
        pass


def test_the_bot_api_requests():
    seen, made = [], []

    def connect(host, port, https, timeout):
        made.append((host, port, https, timeout))
        return FakeConn(seen)

    tg = Telegram("T0K", "http://tg.example:8080/", connect=connect)
    tg.send_message("42", "текст")
    assert tg.get_updates(5, 25) == [{"update_id": 1}]
    assert tg.get_updates(None) == [{"update_id": 1}]
    assert made[0] == ("tg.example", 8080, False, 10.0) and made[1][3] == 35
    assert seen[0] == ("POST", "/botT0K/sendMessage", {"chat_id": "42", "text": "текст"},
                       {"content-type": "application/json"})
    assert seen[1][1:3] == ("/botT0K/getUpdates", {"offset": 5, "timeout": 25, "allowed_updates": ["message"]})
    assert seen[2][2] == {"timeout": 25, "allowed_updates": ["message"]}
    bad = Telegram("T0K", connect=lambda *a: FakeConn([], answer=(200, {"ok": False, "description": "chat not found"})))
    with pytest.raises(telegram.TelegramError, match="chat not found"):
        bad.send_message("1", "x")
    with pytest.raises(telegram.TelegramError):
        Telegram(None).send_message("1", "x")


def test_ownership_loss_aborts_the_long_poll_in_flight():
    """Review M3: as Express aborts its getUpdates fetch when the renewal returns 0."""
    conns = []

    def connect(*a):
        conns.append(FakeConn([], block=True))
        return conns[-1]

    tg = Telegram("T0K", connect=connect)
    r = FakeRedis()
    p = Poller(tg, r, idle_s=5, renew_every_s=0.05, min_poll_s=0.01).start()
    try:
        _until(lambda: conns)
        assert not conns[0].gone.is_set()
        t0 = time.monotonic()
        r.data[POLLER_KEY] = "thief"
        _until(lambda: conns[0].gone.is_set())
        assert time.monotonic() - t0 < 1  # not after the 25 s long poll
        _until(lambda: not p._owner.is_set())
    finally:
        p.stop()
