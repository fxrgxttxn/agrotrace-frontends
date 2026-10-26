"""
Telegram Bot API (FR-NOTIF-02), the port of backend-express/src/infra/telegram.ts: `send_message` for notification
delivery and the `getUpdates` poller that links accounts (`/start <code>`; contract info.description, shared Redis
keys `tgcode:{code}` and `tg:poller`).

Without `TELEGRAM_BOT_TOKEN` the client is not configured: TELEGRAM notification rows end NOT_CONFIGURED without an
attempt (contracts/events/notification.dispatch.schema.json) and no poller runs. On the stand only api-django has a
token (P14/P51), so worker-django never polls and never sends.

Poller (`start_poller()` — a thread of the worker, started on `worker_ready`, stopped on `worker_shutdown`): only the
process holding `tg:poller` polls — `SET tg:poller <instance> NX EX 30`, renewed every 10 s by the owner with the
contract's Lua compare-and-PEXPIRE (0 → ownership lost: the long poll in flight is aborted, as Express does — any updates it returned are dropped, the
offset does not move — and the process competes for the key again). The offset (`last update_id + 1`) moves past an
update only once it was handled; Telegram confirms it on the next `getUpdates`, so a new owner continues where the
previous one stopped and a message seen twice is harmless (`GETDEL tgcode:{code}`). The poller thread uses the
database only for the one `UPDATE users` of a link (autocommit; the connection goes straight back — P61 budget).
"""

from __future__ import annotations

import http.client
import json
import logging
import socket
import threading
import time
import urllib.parse
import uuid
from collections.abc import Callable
from typing import Any

from agrotrace.core.patterns import ecma

log = logging.getLogger("agrotrace.telegram")

#: The contract's renewal script (shared Redis keys table, `tg:poller`).
RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], 30000) end return 0"
RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"
POLLER_KEY = "tg:poller"
POLLER_TTL_S = 30
RENEW_EVERY_S = 10.0
LONG_POLL_S = 25
IDLE_S = 10.0
REQUEST_TIMEOUT_S = 10.0
_START = ecma(r"^\/start(?:@\w+)?\s+(\S+)\s*$")


class TelegramError(RuntimeError):
    pass


class Telegram:
    """The Bot API client. `token` None/'' — not configured (every call raises). Requests go over http.client so that
    the long poll in flight can be aborted from another thread (`abort()`: its socket is shut down), as Express aborts
    its `getUpdates` fetch when ownership of `tg:poller` is lost."""

    def __init__(self, token: str | None, api_url: str = "https://api.telegram.org", *,
                 request_timeout: float = REQUEST_TIMEOUT_S,
                 connect: Callable[[str, int | None, bool, float], Any] | None = None):
        self.token = token or None
        self.api_url = api_url.rstrip("/")
        self.request_timeout = request_timeout
        self._connect = connect or _connection
        self._lock = threading.Lock()
        self._polling: Any = None

    @property
    def configured(self) -> bool:
        return self.token is not None

    def _call(self, method: str, body: dict[str, Any], timeout: float, *, abortable: bool = False) -> Any:
        if not self.token:
            raise TelegramError("telegram is not configured")
        u = urllib.parse.urlsplit(self.api_url)
        conn = self._connect(u.hostname or "", u.port, u.scheme == "https", timeout)
        if abortable:
            with self._lock:
                self._polling = conn
        try:
            conn.request("POST", f"{u.path}/bot{self.token}/{method}", body=json.dumps(body).encode("utf-8"),
                         headers={"content-type": "application/json"})
            res = conn.getresponse()
            status, raw = res.status, res.read()
        except (OSError, http.client.HTTPException) as e:
            raise TelegramError(f"telegram {method}: {e}") from e
        finally:
            if abortable:
                with self._lock:
                    self._polling = None
            conn.close()
        try:
            doc = json.loads(raw)
        except ValueError:
            doc = None
        if not (200 <= status < 300) or not isinstance(doc, dict) or doc.get("ok") is not True:
            desc = doc.get("description", "") if isinstance(doc, dict) else ""
            raise TelegramError(f"telegram {method}: {status} {desc}".strip())
        return doc.get("result")

    def send_message(self, chat_id: str, text: str) -> None:
        """One attempt; raises on a transport error or `ok: false`."""
        self._call("sendMessage", {"chat_id": chat_id, "text": text}, self.request_timeout)

    def get_updates(self, offset: int | None, timeout_sec: int = LONG_POLL_S) -> list[dict[str, Any]]:
        body: dict[str, Any] = {"timeout": timeout_sec, "allowed_updates": ["message"]}
        if offset is not None:
            body = {"offset": offset, **body}
        result = self._call("getUpdates", body, timeout_sec + 10, abortable=True)
        return result if isinstance(result, list) else []

    def abort(self) -> None:
        """Ends the `getUpdates` in flight, if any (it raises TelegramError in its own thread)."""
        with self._lock:
            conn = self._polling
        sock = getattr(conn, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _connection(host: str, port: int | None, https: bool, timeout: float) -> http.client.HTTPConnection:
    cls = http.client.HTTPSConnection if https else http.client.HTTPConnection
    return cls(host, port, timeout=timeout)


def client() -> Telegram:
    from agrotrace.core import config

    c = config.get()
    return Telegram(c.TELEGRAM_BOT_TOKEN, c.TELEGRAM_API_URL)


def link_by_code(code: str, chat_id: str, *, redis_client: Any = None) -> bool:
    """`GETDEL tgcode:{code}` (one-time, contract) → `users.telegram_chat_id` of its user."""
    from agrotrace.core import sql
    from agrotrace.infra import redis

    r = redis_client if redis_client is not None else redis.client()
    raw = r.getdel(f"tgcode:{code}")
    if raw is None:
        return False
    try:
        user_id = json.loads(raw).get("userId")
    except (ValueError, AttributeError):
        return False
    if not isinstance(user_id, str):
        return False
    try:
        uuid.UUID(user_id)
    except ValueError:
        return False
    n = sql.execute("UPDATE users SET telegram_chat_id = %s WHERE id = %s AND deleted_at IS NULL", [chat_id, user_id])
    if n == 0:
        return False
    log.info("telegram linked", extra={"userId": user_id})
    return True


class Poller:
    """The `tg:poller` loop (see the module header). `run()` blocks until `stop()`; `start()` runs it on a thread."""

    def __init__(self, telegram: Telegram, redis_client: Any, *,
                 link: Callable[[str, str], bool] | None = None,
                 idle_s: float = IDLE_S, renew_every_s: float = RENEW_EVERY_S, min_poll_s: float = 1.0):
        self.telegram = telegram
        self.redis = redis_client
        self.link = link or (lambda code, chat: link_by_code(code, chat, redis_client=redis_client))
        self.idle_s = idle_s
        self.renew_every_s = renew_every_s
        self.min_poll_s = min_poll_s
        self.instance = str(uuid.uuid4())
        self.offset: int | None = None
        self._stopping = threading.Event()
        self._owner = threading.Event()
        self._thread: threading.Thread | None = None

    # ── ownership ──
    def renew_once(self) -> bool:
        """One renewal by the contract's script; False (0) — ownership lost: polling stops."""
        try:
            n = self.redis.eval(RENEW, 1, POLLER_KEY, self.instance)
        except Exception as e:  # a Redis hiccup: try again at the next renewal (the key lives 30 s)
            log.warning("telegram poller renewal failed", extra={"err": str(e)})
            return self._owner.is_set()
        if int(n) == 0:
            self._owner.clear()
            self.telegram.abort()  # as Express aborts its fetch: the long poll in flight ends now (review M3)
            return False
        return True

    def _renew_loop(self) -> None:
        while self._owner.is_set() and not self._stopping.wait(self.renew_every_s):
            if not self._owner.is_set() or not self.renew_once():
                return

    def take(self) -> bool:
        return bool(self.redis.set(POLLER_KEY, self.instance, nx=True, ex=POLLER_TTL_S))

    # ── polling ──
    def handle(self, updates: list[dict[str, Any]]) -> None:
        for u in updates:
            message = u.get("message") if isinstance(u.get("message"), dict) else {}
            text = message.get("text") if isinstance(message.get("text"), str) else ""
            chat = message.get("chat", {}).get("id") if isinstance(message.get("chat"), dict) else None
            m = _START.search(text)
            # The offset moves past an update only once it was handled (a failed link is seen again).
            if m and chat is not None:
                self.link(m.group(1), str(chat))
            self.offset = int(u["update_id"]) + 1

    def poll_once(self) -> None:
        started = time.monotonic()
        updates = self.telegram.get_updates(self.offset, LONG_POLL_S)
        if not self._owner.is_set() or self._stopping.is_set():
            return  # ownership lost (or stopping) during the long poll: drop what it returned
        self.handle(updates)
        # A Bot API (or stub) answering an empty long poll at once must not spin the loop.
        if not updates and time.monotonic() - started < self.min_poll_s:
            self._stopping.wait(self.min_poll_s)

    def own_loop(self) -> None:
        self._owner.set()
        self.offset = None  # Express keeps the offset per ownership (Telegram confirms it server-side)
        renewer = threading.Thread(target=self._renew_loop, name="tg-poller-renew", daemon=True)
        renewer.start()
        try:
            while not self._stopping.is_set() and self._owner.is_set():
                try:
                    self.poll_once()
                except Exception as e:
                    if self._stopping.is_set() or not self._owner.is_set():
                        break
                    log.warning("telegram poll failed", extra={"err": str(e)})
                    self._stopping.wait(self.idle_s)
        finally:
            self._owner.clear()

    def run(self) -> None:
        if not self.telegram.configured:
            return
        while not self._stopping.is_set():
            try:
                if self.take():
                    self.own_loop()
            except Exception as e:
                log.warning("telegram poller lock failed", extra={"err": str(e)})
            finally:
                from django.db import connections

                connections.close_all()
            if not self._stopping.is_set():
                self._stopping.wait(self.idle_s)

    def start(self) -> Poller:
        self._thread = threading.Thread(target=self.run, name="tg-poller", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 2.0) -> None:
        """Stops polling; hands the key over at once (only while still ours). A long poll in flight is not waited
        for longer than `timeout` (the thread is a daemon; its result is dropped)."""
        self._stopping.set()
        self.telegram.abort()
        if self._thread is not None:
            self._thread.join(timeout)
        try:
            self.redis.eval(RELEASE, 1, POLLER_KEY, self.instance)
        except Exception:  # noqa: BLE001 - best effort: the key expires in 30 s anyway
            pass


_poller: Poller | None = None


def start_poller() -> Poller | None:
    """The worker's poller (no token — none)."""
    global _poller
    from agrotrace.infra import redis

    tg = client()
    if not tg.configured:
        return None
    _poller = Poller(tg, redis.client()).start()
    return _poller


def stop_poller() -> None:
    global _poller
    if _poller is not None:
        _poller.stop()
        _poller = None
