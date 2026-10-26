"""
The SSE hub of the api process (contracts/openapi/paths/events.yaml, spec 8.4, R33, P46, P53, N1), the port of
backend-express/src/sse/hub.ts on asyncio (the uvicorn event loop): ONE PostgreSQL session holds `LISTEN
notifications` and fans the payloads out to this process's open streams. The `notifications` trigger emits
`{"id", "user_id"}` for every IN_APP row any implementation inserts (cross-backend delivery); markNotificationsRead
emits `{"user_id", "unread": true}`.

- payload with `id`: the row is read once and every stream of the user gets `notification` (`id:` = seq) then
  `unread`; payload without `id`: `unread` only;
- payloads are handled one after another (one serial queue), so a user's events keep the commit order of NOTIFY;
- a stream never sends the same notification twice (per-stream set of sent ids; a stream lives ≤ 15 minutes);
- every stream has a watermark W: at connect the higher of L (`Last-Event-ID`) and the user's highest IN_APP seq at
  that moment, raised by every notification sent. After a LISTEN reconnect (NOTIFY sent meanwhile are lost) each
  stream gets the rows with seq > W, plus unread rows with seq < W created no earlier than 60 s before the session
  was lost (late commits, the T3-5 note), then `unread` — never the user's history (contract text). A stream still in
  its connect sequence during a resync is skipped by it and catches up itself at the end of that sequence (N1);
- the LISTEN session is a dedicated `psycopg.AsyncConnection` (autocommit, TCP keepalive) on which ONLY `LISTEN
  notifications` ever runs — also the liveness probe every 30 s (10 s timeout) — so `pg_stat_activity.query` of the
  session is always `LISTEN notifications` (the contract's rule for every implementation: the stand terminates it by
  that text). Notifications are read with `conn.notifies(timeout=30)` (psycopg 3.2), which returns at least every
  30 s: an open `notifies()` generator holds the connection's lock, and the probe could not run otherwise (D-M4). A
  failed probe or read is a lost session: reconnect with a back-off (0.5 s doubling to 10 s), then `resync()`;
- a client that does not read (more than 1 MiB buffered) loses its stream.
Reads go through the SSE pool (sse/dbpool.py, 2 connections).

Connect (streamEvents, sse/stream.py): register the stream (live events are buffered), read the watermark, replay
the missed rows, flush the buffer, send `unread`; `ping` every 25 s; `reauth` at the token's `exp`, then the stream
ends. A stream leaves the hub on every end (client gone — CancelledError in the generator —, reauth, back-pressure,
shutdown).

Replay for L (contract text): the user's IN_APP rows with `seq > L`, plus unread rows with `seq < L` created at most
60 s before row L (`seq` is taken at INSERT, so a transaction that inserted earlier but committed after row L was sent
has a lower seq); ordered by seq.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import psycopg

from agrotrace.core.render import iso, json_dumps
from agrotrace.core.sql import jsonb
from agrotrace.sse import dbpool

log = logging.getLogger("agrotrace.sse")

PING_S = 25
LATE_COMMIT_WINDOW_SEC = 60
PROBE_S = 30
PROBE_TIMEOUT_S = 10
RECONNECT_MIN_S = 0.5
RECONNECT_MAX_S = 10.0
SENT_CAP = 10_000
MAX_BUFFERED_BYTES = 1024 * 1024
LISTEN = "LISTEN notifications"
APPLICATION_NAME = "agrotrace-django-api-sse-listen"

COLUMNS = "id::text AS id, seq, type, payload, is_read, created_at"


def iso_sec(dt: datetime) -> str:
    """`2026-09-24T09:00:37Z` (the ping's `ts`: no milliseconds)."""
    return iso(dt)[:19] + "Z"


def notification_view(r: dict[str, Any]) -> dict[str, Any]:
    return {"id": r["id"], "seq": int(r["seq"]), "type": r["type"], "payload": jsonb(r["payload"]) or {},
            "isRead": r["is_read"], "createdAt": iso(r["created_at"])}


def frame(event: str, data: Any, id: int | None = None) -> str:  # noqa: A002
    """One SSE event: only `id:` / `event:` / `data:` lines (no `retry:`, no comments)."""
    head = f"id: {id}\n" if id is not None else ""
    return f"{head}event: {event}\ndata: {json_dumps(data)}\n\n"


class Stream:
    """One open `GET /events/stream` of a user. The hub writes frames into `pending`; the response generator
    (sse/stream.py) drains them. `end()` is the server ending the stream; `dispose()` — the stream is over."""

    def __init__(self, user_id: str, exp: int, forget: Callable[[Stream], None] | None = None) -> None:
        self.user_id = user_id
        self.exp = exp
        self.watermark = 0
        #: Live notifications that arrived while the connect sequence was running.
        self.buffer: list[dict[str, Any]] | None = []
        self.closed = False
        self.sent: set[str] = set()
        self.pending: deque[str] = deque()
        self.pending_bytes = 0
        self._wake = asyncio.Event()
        self._forget = forget
        #: The task that sends the response (cancelled to end a stream whose client does not read).
        self.task: asyncio.Task | None = None

    # ── output ──
    def write(self, chunk: str) -> None:
        if self.closed:
            return
        self.pending.append(chunk)
        self.pending_bytes += len(chunk.encode("utf-8"))
        self._wake.set()
        if self.pending_bytes > MAX_BUFFERED_BYTES:
            log.warning("sse client does not read; stream ended", extra={"userId": self.user_id})
            self.pending.clear()
            self.pending_bytes = 0
            self.end()
            if self.task is not None and self.task is not asyncio.current_task():
                self.task.cancel()  # the response is stuck in a send that waits for the client to read

    def take(self) -> str | None:
        if not self.pending:
            return None
        chunk = self.pending.popleft()
        self.pending_bytes -= len(chunk.encode("utf-8"))
        return chunk

    async def wait(self, timeout: float) -> None:
        if self.pending or self.closed:
            return
        self._wake.clear()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), max(0, timeout))

    # ── events ──
    def notification(self, n: dict[str, Any]) -> None:
        if self.buffer is not None:
            self.buffer.append(n)
            return
        self.send(n)

    def send(self, n: dict[str, Any]) -> None:
        """Sends now, also during the connect sequence (deduplicated)."""
        if n["id"] in self.sent:
            return
        if len(self.sent) >= SENT_CAP:
            self.sent.clear()
        self.sent.add(n["id"])
        if n["seq"] > self.watermark:
            self.watermark = n["seq"]
        self.write(frame("notification", n, n["seq"]))

    def unread(self, count: int) -> None:
        if self.buffer is not None:
            return  # the connect sequence ends with its own `unread`
        self.write(frame("unread", {"count": count}))

    def flush(self) -> None:
        """Ends the connect phase: buffered live notifications go out (deduplicated, by seq)."""
        buffered = self.buffer or []
        self.buffer = None
        for n in sorted(buffered, key=lambda x: x["seq"]):
            self.send(n)

    def ping(self, now: datetime) -> None:
        self.write(frame("ping", {"ts": iso_sec(now)}))

    def reauth(self) -> None:
        self.write(frame("reauth", {"reason": "TOKEN_EXPIRED"}))
        self.end()

    def end(self) -> None:
        """The server ends the stream (reauth, back-pressure, shutdown): what is pending still goes out."""
        if self.closed:
            return
        self.closed = True
        self._wake.set()
        if self._forget is not None:
            self._forget(self)

    def dispose(self) -> None:
        self.closed = True
        self._wake.set()
        if self._forget is not None:
            self._forget(self)


class Hub:
    def __init__(self, *, pool: dbpool.SsePool | None = None, probe_s: float = PROBE_S,
                 probe_timeout_s: float = PROBE_TIMEOUT_S,
                 connect: Callable[[], Awaitable[psycopg.AsyncConnection]] | None = None) -> None:
        self.pool = pool
        self.probe_s = probe_s
        self.probe_timeout_s = probe_timeout_s
        self._connect_listen = connect or self._default_connect
        self.streams: dict[str, set[Stream]] = {}
        self.stopped = False
        #: No new stream is served once the process shuts down.
        self.stopped_streams = False
        self.listening = asyncio.Event()
        #: Resyncs so far and the loss time of the latest (a connecting stream compares them, N1).
        self.resyncs = 0
        self.last_loss = datetime.fromtimestamp(0, UTC)
        self._lost_at: datetime | None = None
        self._queue: asyncio.Queue[Callable[[], Awaitable[None]] | None] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._conn: psycopg.AsyncConnection | None = None

    # ── lifecycle ──
    async def start(self) -> None:
        if self.pool is None:
            self.pool = dbpool.SsePool()
        await self.pool.open()
        self._tasks = [asyncio.create_task(self._serve_queue(), name="sse-queue"),
                       asyncio.create_task(self._listen_forever(), name="sse-listen")]

    async def close(self) -> None:
        self.stopped = True
        for streams in list(self.streams.values()):
            for s in list(streams):
                s.end()
        self.streams.clear()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []
        if self._conn is not None:
            with contextlib.suppress(Exception):
                await self._conn.close()
        if self.pool is not None:
            await self.pool.close()

    def end_streams(self) -> None:
        """Ends every open stream (shutdown); the LISTEN session stays until `close()`."""
        self.stopped_streams = True
        for streams in list(self.streams.values()):
            for s in list(streams):
                s.end()

    @property
    def size(self) -> int:
        return sum(len(v) for v in self.streams.values())

    # ── streams ──
    def register(self, s: Stream) -> None:
        s._forget = self._forget
        self.streams.setdefault(s.user_id, set()).add(s)

    def _forget(self, s: Stream) -> None:
        group = self.streams.get(s.user_id)
        if group is None:
            return
        group.discard(s)
        if not group:
            self.streams.pop(s.user_id, None)

    def user_streams(self, user_id: str) -> list[Stream]:
        return [s for s in self.streams.get(user_id, ()) if not s.closed]

    # ── reads ──
    async def row_by_id(self, notification_id: str) -> dict[str, Any] | None:
        r = await self.pool.one(f"SELECT {COLUMNS} FROM notifications WHERE id = %s AND channel = 'IN_APP'",
                                [notification_id])
        return notification_view(r) if r else None

    async def unread_count(self, user_id: str) -> int:
        return int(await self.pool.scalar(
            "SELECT count(*) AS n FROM notifications WHERE user_id = %s AND channel = 'IN_APP' AND is_read = false",
            [user_id]))

    # ── the serial queue ──
    def enqueue(self, job: Callable[[], Awaitable[None]]) -> None:
        self._queue.put_nowait(job)

    async def _serve_queue(self) -> None:
        while True:
            job = await self._queue.get()
            if job is None:
                return
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("sse event failed", extra={"err": str(e)})

    async def handle(self, payload: str | None) -> None:
        try:
            msg = json.loads(payload or "")
        except ValueError:
            return
        if not isinstance(msg, dict) or not isinstance(msg.get("user_id"), str):
            return
        user_id = msg["user_id"]
        if not self.user_streams(user_id):
            return
        if isinstance(msg.get("id"), str):
            n = await self.row_by_id(msg["id"])
            if n is not None:
                for s in self.user_streams(user_id):
                    s.notification(n)
        count = await self.unread_count(user_id)
        for s in self.user_streams(user_id):
            s.unread(count)

    async def catch_up(self, s: Stream, since: datetime) -> None:
        """The rows one stream may have missed while the session was down (see the module header)."""
        rows = await self.pool.all(
            f"SELECT {COLUMNS} FROM notifications WHERE user_id = %s AND channel = 'IN_APP' "
            "AND (seq > %s::bigint OR (seq < %s::bigint AND NOT is_read "
            "AND created_at >= %s::timestamptz - make_interval(secs => %s))) ORDER BY seq",
            [s.user_id, s.watermark, s.watermark, since, LATE_COMMIT_WINDOW_SEC])
        for r in rows:
            s.send(notification_view(r))

    async def resync(self, since: datetime) -> None:
        """After a LISTEN reconnect. A stream still in its connect sequence is skipped here and catches up itself
        (N1)."""
        self.resyncs += 1
        self.last_loss = since
        for user_id, group in list(self.streams.items()):
            for s in list(group):
                if s.closed or s.buffer is not None:
                    continue
                await self.catch_up(s, since)
            count = await self.unread_count(user_id)
            for s in self.user_streams(user_id):
                s.unread(count)

    async def connect_sequence(self, s: Stream, last_seq: str | None) -> None:
        """streamEvents after registration: watermark, replay for L, flush, (catch-up), unread."""
        seen = self.resyncs
        try:
            current = int(await self.pool.scalar(
                "SELECT coalesce(max(seq), 0)::text AS max FROM notifications WHERE user_id = %s "
                "AND channel = 'IN_APP'", [s.user_id]))
            given = int(last_seq) if last_seq is not None else 0
            if last_seq is not None:
                rows = await self.pool.all(
                    "SELECT n.id::text AS id, n.seq, n.type, n.payload, n.is_read, n.created_at FROM notifications n "
                    "WHERE n.user_id = %s AND n.channel = 'IN_APP' AND (n.seq > %s::bigint "
                    "OR (n.seq < %s::bigint AND NOT n.is_read AND n.created_at >= ("
                    "SELECT l.created_at - make_interval(secs => %s) FROM notifications l "
                    "WHERE l.seq = %s::bigint AND l.user_id = %s))) ORDER BY n.seq",
                    [s.user_id, last_seq, last_seq, LATE_COMMIT_WINDOW_SEC, last_seq, s.user_id])
                for r in rows:
                    s.send(notification_view(r))
            floor = max(given, current)
            if floor > s.watermark:
                s.watermark = floor
        finally:
            s.flush()
        # A reconnect resync ran while this stream was connecting (it was skipped there): catch up now.
        if self.resyncs != seen and not s.closed:
            await self.catch_up(s, self.last_loss)
        if s.closed:
            return
        s.unread(await self.unread_count(s.user_id))

    # ── the LISTEN session ──
    async def _default_connect(self) -> psycopg.AsyncConnection:
        return await psycopg.AsyncConnection.connect(
            dbpool.conninfo(), autocommit=True, application_name=APPLICATION_NAME, options="-c TimeZone=UTC",
            keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3, connect_timeout=10)

    def _lost(self) -> None:
        if self._lost_at is None:
            self._lost_at = datetime.now(UTC)
        self.listening.clear()

    async def _listen_forever(self) -> None:
        attempt = 0
        while not self.stopped:
            conn: psycopg.AsyncConnection | None = None
            try:
                conn = await self._connect_listen()
                await asyncio.wait_for(conn.execute(LISTEN), self.probe_timeout_s)
                self._conn = conn
                attempt = 0
                self.listening.set()
                if self._lost_at is not None:
                    since, self._lost_at = self._lost_at, None
                    self.enqueue(lambda since=since: self.resync(since))
                while not self.stopped:
                    async for n in conn.notifies(timeout=self.probe_s):
                        if n.channel == "notifications":
                            self.enqueue(lambda p=n.payload: self.handle(p))
                    # The liveness probe — the same statement, so the session's last query stays `LISTEN …`.
                    await asyncio.wait_for(conn.execute(LISTEN), self.probe_timeout_s)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._lost()
                if not self.stopped:
                    if attempt == 0:
                        log.warning("sse listen session lost; reconnecting", extra={"err": str(e)})
            finally:
                self._conn = None
                if conn is not None:
                    with contextlib.suppress(Exception):
                        await conn.close()
            if self.stopped:
                return
            delay = min(RECONNECT_MIN_S * 2 ** attempt, RECONNECT_MAX_S)
            attempt += 1
            await asyncio.sleep(delay)


_hub: Hub | None = None


def hub() -> Hub | None:
    return _hub


async def start() -> None:
    """lifespan start-up of the api (asgi.py): the LISTEN session exists from the start, as in Express."""
    global _hub
    if _hub is None:
        _hub = Hub()
        await _hub.start()
        _end_streams_on_sigterm(_hub)


def _end_streams_on_sigterm(h: Hub) -> None:
    """SSE streams never end on their own, and uvicorn waits for open responses before the lifespan shutdown: on
    SIGTERM the streams end first (clients reconnect to another instance — Express closes its hub before the
    server), then uvicorn's own handler runs as before."""
    loop = asyncio.get_running_loop()
    try:
        previous = signal.getsignal(signal.SIGTERM)
    except (ValueError, OSError):  # pragma: no cover - not the main thread
        return
    if not callable(previous):
        return

    def handler(signum, frame):
        loop.call_soon_threadsafe(h.end_streams)
        previous(signum, frame)

    try:
        signal.signal(signal.SIGTERM, handler)
    except (ValueError, OSError):  # pragma: no cover
        pass


async def close() -> None:
    """lifespan shutdown: the hub closes first (its streams end; clients reconnect elsewhere)."""
    global _hub
    h, _hub = _hub, None
    if h is not None:
        await h.close()
