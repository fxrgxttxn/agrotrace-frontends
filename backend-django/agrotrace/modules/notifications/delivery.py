"""
The delivery half of `notification.dispatch` (contracts/events/notification.dispatch.schema.json, P45, P49, N5), the
port of backend-express/src/modules/notifications/delivery.ts. Every PENDING EMAIL/TELEGRAM row a handler inserted is
sent after the handler's commit with up to 3 attempts — success → DELIVERED, every attempt failed → FAILED, channel
not configured on this server (no SMTP_HOST, no bot token) → NOT_CONFIGURED without an attempt; an unlinked TELEGRAM
row → FAILED without an attempt. Waits after a failed attempt: 1 s and 2 s (P45). An attempt that has not finished
within 30 s (ATTEMPT_TIMEOUT_S: `Future.result(timeout=30)` over the attempt's own thread; smtplib's EMAIL_TIMEOUT 10 s
and the Bot API's 10 s request timeout sit below it) counts as failed — far below the 5-minute claim threshold, so a
hung transport never outlives its claim.

Claims (P49, per send, at-least-once): a row is claimed right before its first attempt — one autocommit `UPDATE …
SET claimed_at = now() … RETURNING claimed_at::text` on the row still PENDING (`fresh`: no claim or one older than 5
minutes; `stale`, the delivery sweeper: `coalesce(claimed_at, created_at)` older than 5 minutes) — and renewed before
every attempt, only while `claimed_at` still equals this sender's stamp (else it stops without sending or writing).
`attempts` is stored after every failed attempt and every write is guarded by the stamp AND `delivery_status =
'PENDING'`, so a row has one sender at a time and never more than 3 attempts. The stamp is the exact text of the
column (microseconds; compared as `claimed_at = %s::timestamptz`) and never passes through a Python datetime.

Processes (P61 budget, D-I5):
- worker — `deliver(ids, mode='fresh')` hands the rows to the process's pool of WORKER_DELIVERY_SLOTS (2) send
  threads and returns at once (the event is acknowledged independently, decision 6 of Express Tasks 12-13); a row is
  claimed only once a slot takes it, so its claim never ages while it waits. A send thread holds a pool connection
  only for the claim, a renewal or a write (autocommit statements; core.sql gives the connection back after each), never
  across SMTP/Telegram. The worker's shutdown waits only for the sends in flight (`shutdown()`).
- beat — the job `notification-delivery` (`sweep()`) sends `mode='stale'` synchronously on the job's thread and its
  pinned connection (one connection per job), without threads of its own.
Texts: infra.i18n.notification_message (`email.subject`/`email.body`, `telegram`), Russian. A rare duplicate email
after a crash between a send and its status update is accepted (P49).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Any, Literal

from django.db import connections

from agrotrace.core import config, sql
from agrotrace.infra import i18n, mailer, telegram

log = logging.getLogger("agrotrace.delivery")

DELIVERY_ATTEMPTS = 3
#: Waits after the 1st and the 2nd failed attempt (P45; there is no 4th attempt).
DELIVERY_DELAYS_S: tuple[int, ...] = (1, 2)
#: A claim older than this was abandoned (its sender died); longer than any send of 3 attempts.
CLAIM_STALE_SEC = 300
#: One attempt (either channel) that has not finished within this long counts as failed (N5).
ATTEMPT_TIMEOUT_S = 30
SWEEP_BATCH = 100
#: A stale sweep tick claims no new row after this long (review M2 ruling).
SWEEP_TICK_BUDGET_S = 240

Mode = Literal["fresh", "stale"]
Status = Literal["DELIVERED", "FAILED", "NOT_CONFIGURED"]


@dataclass
class DeliveryRow:
    id: str
    type: str
    payload: dict[str, Any]
    channel: str
    email: str
    telegram_chat_id: str | None
    #: Attempts already made (by a previous sender).
    attempts: int = 0


@dataclass(frozen=True)
class Outcome:
    status: Status
    attempts: int


class AttemptTimeout(RuntimeError):
    pass


def with_deadline(fn: Callable[[], Any], timeout_s: float) -> Any:
    """Runs `fn` on its own thread and waits at most `timeout_s` (`Future.result(timeout=…)`); a late attempt raises
    AttemptTimeout (its thread is left to finish — the transports' own timeouts end it)."""
    fut: Future = Future()

    def run() -> None:
        if not fut.set_running_or_notify_cancel():
            return
        try:
            fut.set_result(fn())
        except BaseException as e:  # noqa: BLE001 - handed to the waiter
            fut.set_exception(e)

    threading.Thread(target=run, name="notify-attempt", daemon=True).start()
    try:
        return fut.result(timeout=timeout_s)
    except FutureTimeout:
        raise AttemptTimeout(f"attempt timed out after {timeout_s} s") from None


def _sleep(seconds: float) -> None:  # tests replace it
    time.sleep(seconds)


def send_row(
    row: DeliveryRow,
    *,
    mail_configured: bool,
    tg: telegram.Telegram,
    send_email: Callable[[str, str, str], None] | None = None,
    before_attempt: Callable[[], bool] | None = None,
    on_failure: Callable[[int], None] | None = None,
    sleep: Callable[[float], None] | None = None,
    attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
) -> Outcome | None:
    """Sends one PENDING row (no database of its own): the outcome to store, or None when `before_attempt` says the
    row is no longer ours (stop, store nothing). `on_failure(attempts)` follows every failed attempt but the last."""
    pause = sleep or _sleep
    done = row.attempts or 0
    if row.channel == "TELEGRAM" and not tg.configured:
        return Outcome("NOT_CONFIGURED", done)
    if row.channel == "EMAIL" and not mail_configured:
        return Outcome("NOT_CONFIGURED", done)
    if row.channel == "TELEGRAM" and row.telegram_chat_id is None:
        return Outcome("FAILED", done)
    if done >= DELIVERY_ATTEMPTS:
        return Outcome("FAILED", done)
    if row.channel == "EMAIL":
        subject = i18n.notification_message(row.type, row.payload, "email.subject")
        text = i18n.notification_message(row.type, row.payload, "email.body")

        def send() -> None:
            (send_email or mailer.send_once)(row.email, subject, text)
    else:
        message = i18n.notification_message(row.type, row.payload, "telegram")
        chat = row.telegram_chat_id

        def send() -> None:
            tg.send_message(chat, message)  # type: ignore[arg-type]

    attempt = done
    while True:
        attempt += 1
        if before_attempt is not None and not before_attempt():
            return None
        try:
            with_deadline(send, attempt_timeout_s)
            return Outcome("DELIVERED", attempt)
        except Exception as e:
            log.warning("notification send failed", extra={"err": str(e), "notificationId": row.id,
                                                            "channel": row.channel, "attempt": attempt})
            if attempt >= DELIVERY_ATTEMPTS:
                return Outcome("FAILED", attempt)
            if on_failure is not None:
                on_failure(attempt)
            pause(DELIVERY_DELAYS_S[attempt - 1] if attempt - 1 < len(DELIVERY_DELAYS_S) else 0)


# ── claims and writes (autocommit statements; a connection only around each) ─────────────────────────────────────

_STALE = "now() - make_interval(secs => %s)"
_CLAIM = (
    "WITH taken AS (UPDATE notifications n SET claimed_at = now() "
    "WHERE n.id = %s AND n.delivery_status = 'PENDING' AND n.channel <> 'IN_APP' AND {pred} "
    "RETURNING n.id, n.type, n.payload, n.channel, n.attempts, n.user_id, n.claimed_at::text AS stamp) "
    "SELECT t.id::text AS id, t.type, t.payload, t.channel, t.attempts, t.stamp, u.email, "
    "u.telegram_chat_id::text AS telegram_chat_id FROM taken t JOIN users u ON u.id = t.user_id"
)
_PRED: dict[str, str] = {
    "fresh": f"(n.claimed_at IS NULL OR n.claimed_at < {_STALE})",
    "stale": f"coalesce(n.claimed_at, n.created_at) < {_STALE}",
}
_RENEW = ("UPDATE notifications SET claimed_at = now() WHERE id = %s AND delivery_status = 'PENDING' "
          "AND claimed_at = %s::timestamptz RETURNING claimed_at::text AS stamp")
_GUARD = "WHERE id = %s AND delivery_status = 'PENDING' AND claimed_at = %s::timestamptz"


def claim_one(notification_id: str, mode: Mode) -> tuple[DeliveryRow, str] | None:
    """Claims ONE row right before its first attempt: the row and the claim stamp (exact text), or None when another
    sender holds it or it is no longer PENDING."""
    r = sql.one(_CLAIM.format(pred=_PRED[mode]), [notification_id, CLAIM_STALE_SEC])
    if r is None:
        return None
    row = DeliveryRow(id=r["id"], type=r["type"], payload=sql.jsonb(r["payload"]) or {}, channel=r["channel"],
                      email=r["email"], telegram_chat_id=r["telegram_chat_id"], attempts=r["attempts"])
    return row, r["stamp"]


def deliver_one(notification_id: str, mode: Mode, *, tg: telegram.Telegram | None = None,
                mail_configured: bool | None = None, **send_kw: Any) -> Outcome | None:
    """Claim → send (renewing the claim before every attempt) → the guarded write of the outcome."""
    claimed = claim_one(notification_id, mode)
    if claimed is None:
        return None
    row, stamp = claimed
    holder = {"stamp": stamp}

    def renew() -> bool:
        s = sql.scalar(_RENEW, [notification_id, holder["stamp"]])
        if s is None:
            return False
        holder["stamp"] = s
        return True

    def progress(attempts: int) -> None:
        sql.execute(f"UPDATE notifications SET attempts = %s {_GUARD}", [attempts, notification_id, holder["stamp"]])

    out = send_row(row, mail_configured=mailer.configured() if mail_configured is None else mail_configured,
                   tg=tg if tg is not None else telegram.client(), before_attempt=renew, on_failure=progress,
                   **send_kw)
    if out is None:
        return None
    sql.execute(f"UPDATE notifications SET delivery_status = %s, attempts = %s {_GUARD}",
                [out.status, out.attempts, notification_id, holder["stamp"]])
    return out


# ── the process's send slots (worker) ─────────────────────────────────────────────────────────────────────────────

_pool_lock = threading.Lock()
_pool: ThreadPoolExecutor | None = None
_inflight: set[Future] = set()


def _slots() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=config.WORKER_DELIVERY_SLOTS, thread_name_prefix="notify-send")
        return _pool


def _slot_job(notification_id: str) -> None:
    try:
        deliver_one(notification_id, "fresh")
    except Exception as e:
        log.error("notification delivery crashed", exc_info=e, extra={"notificationId": notification_id})
    finally:
        connections.close_all()


def deliver(ids: list[str], *, mode: Mode, budget_s: float | None = None) -> int:
    """`fresh` (worker): the rows go to the send slots, returns at once. `stale` (beat): sent one after another on
    the calling thread and its connection; once `budget_s` has passed no further row is claimed (the rest stay for
    the next tick). Never raises for a failed row. Returns how many rows were handed on or taken."""
    if not ids:
        return 0
    if mode == "fresh":
        pool = _slots()
        for i in ids:
            fut = pool.submit(_slot_job, i)
            with _pool_lock:
                _inflight.add(fut)
            fut.add_done_callback(_forget)
        return len(ids)
    started = time.monotonic()
    taken = 0
    for i in ids:
        if budget_s is not None and time.monotonic() - started >= budget_s:
            log.info("notification-delivery tick budget spent; the rest waits for the next tick",
                     extra={"left": len(ids) - taken})
            break
        taken += 1
        try:
            deliver_one(i, "stale")
        except Exception as e:
            log.error("notification delivery crashed", exc_info=e, extra={"notificationId": i})
    return taken


def _forget(fut: Future) -> None:
    with _pool_lock:
        _inflight.discard(fut)


def idle(timeout: float | None = None) -> bool:
    """Waits until every send handed to the slots has finished; False on timeout."""
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        with _pool_lock:
            pending = list(_inflight)
        if not pending:
            return True
        left = None if deadline is None else max(0, deadline - time.monotonic())
        if left == 0:
            return False
        for f in pending:
            try:
                f.result(timeout=left)
            except FutureTimeout:
                return False
            except Exception:  # noqa: BLE001, S110 - logged by the job
                pass


def shutdown() -> None:
    """The worker stops: the sends in flight finish first; the rows still queued are dropped unclaimed (PENDING, no
    stamp) and the beat's stale sweep sends them after 5 minutes, so a large fan-out never keeps the worker in warm
    shutdown past its grace period (final review M7)."""
    global _pool
    with _pool_lock:
        pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=True, cancel_futures=True)


def sweep(budget_s: float = SWEEP_TICK_BUDGET_S) -> int:
    """One `notification-delivery` tick: the PENDING EMAIL/TELEGRAM rows whose sender died — `coalesce(claimed_at,
    created_at)` older than 5 minutes, oldest first, at most 100 — each claimed (`stale`) and sent within the rest of
    its 3-attempt budget; how many were taken. Serial, as the brief prescribes; after
    `budget_s` (4 minutes) no new row is claimed, so a hung SMTP server ends the tick (and its advisory key) and the
    rest waits for the next tick (review M2)."""
    ids = [r["id"] for r in sql.all(
        "SELECT id::text AS id FROM notifications WHERE delivery_status = 'PENDING' AND channel <> 'IN_APP' "
        f"AND coalesce(claimed_at, created_at) < {_STALE} ORDER BY created_at LIMIT %s",
        [CLAIM_STALE_SEC, SWEEP_BATCH])]
    return deliver(ids, mode="stale", budget_s=budget_s)
