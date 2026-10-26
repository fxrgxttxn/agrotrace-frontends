"""The SSE hub and stream (sse/hub.py, sse/stream.py; contract paths/events.yaml, R33, P46, N1) on agrotrace_test_django,
in an event loop of their own (asyncio.run; rows are written through a plain psycopg session — Django's synchronous
ORM is not allowed in a running loop, which is the rule of the code under test too):

- the watermark W = max(L, the user's highest seq) at connect; replay for L (seq > L + the 60 s late-commit window);
- after a lost LISTEN session only seq > W plus unread rows with seq < W created ≤ 60 s before the loss (P46);
- a stream connecting during a resync catches up itself (N1); dedupe by id within a stream;
- `reauth` at `exp`, then the end; `ping` with `ts` without milliseconds; `Last-Event-ID` wins over `lastEventId`,
  a non-number or more than 18 digits is ignored; more than 1 MiB buffered ends the stream;
- the LISTEN session: its last statement is always `LISTEN notifications` (also after a probe), a live NOTIFY reaches
  the stream (`notification` then `unread`), a terminated session reconnects and resyncs."""

from __future__ import annotations

import asyncio
import json
import re
import time

import pytest

from agrotrace.sse import hub as hub_mod
from agrotrace.sse import stream as stream_mod
from agrotrace.sse.dbpool import SsePool
from agrotrace.sse.hub import LISTEN, Hub, Stream
from tests.world import World

PAYLOAD = json.dumps({"complaintId": "c", "batchId": "b", "publicCode": "AT-2026-990002", "productName": "SSE"})
FRAME = re.compile(r"^(?:id: (\d+)\n)?event: (\w+)\ndata: (.*)\n\n$", re.S)


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


@pytest.fixture
def user(world):
    return world.user(world.org("FARM"))


def insert(session, user_id: str, *, read: bool = False, age_s: int = 0, channel: str = "IN_APP") -> tuple[str, int]:
    row = session.execute(
        "INSERT INTO notifications (user_id, type, payload, channel, delivery_status, is_read, created_at) "
        "VALUES (%s, 'COMPLAINT', %s::jsonb, %s, 'DELIVERED', %s, now() - make_interval(secs => %s)) "
        "RETURNING id::text, seq", [user_id, PAYLOAD, channel, read, age_s]).fetchone()
    return row[0], int(row[1])


def frames(s: Stream) -> list[tuple[str | None, str, object]]:
    out = []
    while (chunk := s.take()) is not None:
        m = FRAME.match(chunk)
        assert m, f"not an SSE frame: {chunk!r}"
        out.append((m.group(1), m.group(2), json.loads(m.group(3))))
    return out


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 60))


async def _hub(**kw) -> Hub:
    h = Hub(pool=SsePool(), **kw)
    await h.pool.open()
    return h


def test_the_watermark_is_the_higher_of_l_and_the_users_highest_seq(user, other_session):
    rows = [insert(other_session, user) for _ in range(3)]
    top = rows[-1][1]

    async def go():
        h = await _hub()
        try:
            s = Stream(user, int(time.time()) + 60)
            h.register(s)
            await h.connect_sequence(s, None)
            assert s.watermark == top
            assert frames(s) == [(None, "unread", {"count": 3})]  # no L: no replay
            s2 = Stream(user, int(time.time()) + 60)
            h.register(s2)
            await h.connect_sequence(s2, str(top + 1000))
            assert s2.watermark == top + 1000
            s3 = Stream(user, int(time.time()) + 60)
            h.register(s3)
            await h.connect_sequence(s3, str(rows[0][1]))
            assert s3.watermark == top
            got = frames(s3)
            assert [f[1] for f in got] == ["notification", "notification", "unread"]
            assert [int(f[0]) for f in got[:2]] == [rows[1][1], rows[2][1]]
            assert got[0][2]["id"] == rows[1][0] and got[0][2]["seq"] == rows[1][1]
            assert set(got[0][2]) == {"id", "seq", "type", "payload", "isRead", "createdAt"}
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", got[0][2]["createdAt"])
        finally:
            await h.pool.close()

    run(go())


def test_replay_for_l_adds_unread_rows_of_the_late_commit_window_before_l(user, other_session):
    early_late = insert(other_session, user)            # lower seq, unread, created with L → replayed
    early_read = insert(other_session, user, read=True)  # lower seq but read → not
    old = insert(other_session, user, age_s=600)        # created long before L → not
    mark = insert(other_session, user)

    async def go():
        h = await _hub()
        try:
            s = Stream(user, int(time.time()) + 60)
            h.register(s)
            await h.connect_sequence(s, str(mark[1]))
            ids = [f[2]["id"] for f in frames(s) if f[1] == "notification"]
            assert ids == [early_late[0]]
            assert early_read[0] not in ids and old[0] not in ids
        finally:
            await h.pool.close()

    run(go())


def test_after_a_lost_listen_only_rows_above_w_and_late_commits_of_60_s(user, other_session):
    old_unread = insert(other_session, user, age_s=300)
    late = insert(other_session, user, age_s=10)
    top = insert(other_session, user, read=True)

    async def go():
        h = await _hub()
        try:
            s = Stream(user, int(time.time()) + 60)
            h.register(s)
            await h.connect_sequence(s, None)
            frames(s)
            w = s.watermark
            assert w == top[1]
            missed = insert(other_session, user)  # its NOTIFY was lost with the session
            since = (await h.pool.one("SELECT now() AS t"))["t"]
            await h.resync(since)
            got = frames(s)
            ids = [f[2]["id"] for f in got if f[1] == "notification"]
            # `late` (seq < W, unread, created 10 s before the loss) and `missed` (seq > W), by seq; the history
            # (old_unread: created 5 minutes before) and the row at W itself are not.
            assert ids == [late[0], missed[0]]
            assert old_unread[0] not in ids
            assert got[-1][1] == "unread"
            assert s.watermark == missed[1]
            await h.resync(since)  # a second resync re-sends nothing (dedupe by id)
            assert [f[1] for f in frames(s)] == ["unread"]
        finally:
            await h.pool.close()

    run(go())


def test_a_stream_connecting_during_a_resync_catches_up_itself(user, other_session):
    insert(other_session, user)

    class GatedPool:
        def __init__(self, inner):
            self.inner = inner
            self.gate = asyncio.Event()
            self.first = True

        async def scalar(self, q, p=None):
            v = await self.inner.scalar(q, p)
            if self.first and "max(seq)" in q:
                self.first = False
                await self.gate.wait()  # the connect sequence is paused right after its watermark read
            return v

        def __getattr__(self, name):
            return getattr(self.inner, name)

    async def go():
        inner = SsePool()
        await inner.open()
        h = Hub(pool=GatedPool(inner))
        try:
            s = Stream(user, int(time.time()) + 60)
            h.register(s)
            connecting = asyncio.create_task(h.connect_sequence(s, None))
            await asyncio.sleep(0.05)
            missed = insert(other_session, user)
            since = (await inner.one("SELECT now() AS t"))["t"]
            await h.resync(since)  # skips s (still connecting)
            assert s.pending == type(s.pending)()
            h.pool.gate.set()
            await connecting
            got = frames(s)
            # `missed` committed after the watermark was read and its NOTIFY was lost: only the stream's own
            # catch-up at the end of its connect sequence can deliver it (the resync skipped the stream).
            assert h.resyncs == 1 and s.buffer is None
            assert [f[2]["id"] for f in got if f[1] == "notification"] == [missed[0]]
            assert got[-1][1] == "unread"
        finally:
            await inner.close()

    run(go())


def test_dedupe_by_id_within_a_stream():
    s = Stream("u", int(time.time()) + 60)
    s.buffer = None
    n = {"id": "x", "seq": 5, "type": "COMPLAINT", "payload": {}, "isRead": False, "createdAt": "t"}
    s.send(n)
    s.send(dict(n))
    s.buffer = []
    s.notification(n)
    s.flush()
    assert [f[1] for f in frames(s)] == ["notification"]


def test_more_than_1_mib_buffered_ends_the_stream():
    async def go():
        s = Stream("u", int(time.time()) + 60)
        s.buffer = None
        victim = asyncio.create_task(asyncio.sleep(30))
        s.task = victim
        gone = []
        s._forget = gone.append
        s.write("x" * (512 * 1024))
        assert not s.closed
        s.write("y" * (512 * 1024 + 1))
        assert s.closed and gone == [s] and s.pending_bytes == 0
        await asyncio.sleep(0)
        assert victim.cancelled() or victim.cancelling()
        s.write("z")
        assert s.take() is None

    run(go())


def test_last_event_id_header_wins_and_non_numbers_are_ignored():
    f = stream_mod.last_event_id
    assert f("5", "7") == "5"
    assert f(None, "7") == "7"
    assert f("abc", "7") is None  # the header is given: it is the value, and it is not a sequence number
    assert f(None, "1" * 18) == "1" * 18
    assert f(None, "1" * 19) is None
    assert f(None, ["1", "2"]) is None
    assert f(None, "12\n") is None and f(None, "") is None


def test_reauth_at_exp_then_the_end_and_ping_without_milliseconds(user):
    class NoDb:
        async def connect_sequence(self, s, last):
            s.flush()
            s.unread(0)

        def register(self, s):
            pass

    async def go():
        s = Stream(user, int(time.time()) + 2)
        t0 = time.monotonic()
        out = []
        async for chunk in stream_mod.events(NoDb(), s, None, ping_s=0.3):
            out.append(chunk)
        elapsed = time.monotonic() - t0
        parsed = [FRAME.match(c) for c in out]
        names = [m.group(2) for m in parsed]
        assert names[0] == "unread" and names[-1] == "reauth" and "ping" in names
        assert json.loads(parsed[-1].group(3)) == {"reason": "TOKEN_EXPIRED"}
        assert 0.9 < elapsed < 3.5
        ts = json.loads(next(m for m in parsed if m.group(2) == "ping").group(3))["ts"]
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", ts)
        assert all(not c.startswith(("retry:", ":")) for c in out)
        assert s.closed

    run(go())


def test_a_cancelled_response_takes_the_stream_out_of_the_hub(user, other_session):
    async def go():
        h = await _hub()
        try:
            s = Stream(user, int(time.time()) + 600)
            gen = stream_mod.events(h, s, None)

            async def consume():
                async for _ in gen:
                    pass

            task = asyncio.create_task(consume())
            await asyncio.sleep(0.3)
            assert h.size == 1
            task.cancel()  # the client went away (Django cancels the response task)
            with pytest.raises(asyncio.CancelledError):
                await task
            assert h.size == 0 and s.closed
        finally:
            await h.pool.close()

    run(go())


def test_the_listen_session_live_notify_probe_and_reconnect(user, other_session):
    async def go():
        h = Hub(pool=SsePool(), probe_s=0.5)
        await h.start()
        try:
            await asyncio.wait_for(h.listening.wait(), 10)
            s = Stream(user, int(time.time()) + 600)
            h.register(s)
            await h.connect_sequence(s, None)
            frames(s)
            live = insert(other_session, user)
            for _ in range(100):
                if s.pending:
                    break
                await asyncio.sleep(0.05)
            await asyncio.sleep(0.2)
            got = frames(s)
            assert [f[1] for f in got] == ["notification", "unread"] and got[0][2]["id"] == live[0]
            other_session.execute("SELECT pg_notify('notifications', json_build_object('user_id', %s::uuid, "
                                  "'unread', true)::text)", [user])
            await asyncio.sleep(0.5)
            assert [f[1] for f in frames(s)] == ["unread"]
            # After a probe the session's statement is still the LISTEN (the contract's rule for the stand).
            await asyncio.sleep(1.2)
            sessions = other_session.execute(
                "SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() "
                "AND application_name = %s", [hub_mod.APPLICATION_NAME]).fetchall()
            assert len(sessions) == 1 and sessions[0][1] == LISTEN
            # The stand's sanctioned action (P48): terminate the session, then insert (its NOTIFY reaches nobody).
            killed = other_session.execute(
                "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = current_database() "
                "AND query = %s AND pid <> pg_backend_pid()", [LISTEN]).fetchall()
            assert killed and all(k[0] for k in killed)
            missed = insert(other_session, user)
            for _ in range(200):
                if any(c.startswith(f"id: {missed[1]}\n") for c in s.pending):
                    break
                await asyncio.sleep(0.05)
            got = frames(s)
            assert [f[2]["id"] for f in got if f[1] == "notification"] == [missed[0]]
            assert h.resyncs == 1 and h.listening.is_set()
            after = insert(other_session, user)
            for _ in range(100):
                if s.pending:
                    break
                await asyncio.sleep(0.05)
            await asyncio.sleep(0.2)
            assert [f[2]["id"] for f in frames(s) if f[1] == "notification"] == [after[0]]
        finally:
            await h.close()
        assert h.size == 0

    run(go())


def test_sigterm_ends_the_streams_first_then_runs_uvicorns_handler(monkeypatch):
    """uvicorn waits for open responses before the lifespan shutdown; SSE streams never end on their own."""
    import signal

    installed = {}
    calls = []
    monkeypatch.setattr(signal, "getsignal", lambda sig: lambda s, f: calls.append("uvicorn"))
    monkeypatch.setattr(signal, "signal", lambda sig, fn: installed.setdefault(sig, fn))

    async def go():
        h = Hub(pool=None)
        s1, s2 = Stream("a", int(time.time()) + 60), Stream("b", int(time.time()) + 60)
        h.register(s1)
        h.register(s2)
        hub_mod._end_streams_on_sigterm(h)
        installed[signal.SIGTERM](signal.SIGTERM, None)
        assert calls == ["uvicorn"]
        await asyncio.sleep(0.01)
        assert s1.closed and s2.closed and h.size == 0 and h.stopped_streams
        late = Stream("c", int(time.time()) + 60)
        assert [c async for c in stream_mod.events(h, late, None)] == []  # no new stream while shutting down

    run(go())
