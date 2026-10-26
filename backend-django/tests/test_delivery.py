"""The delivery half of notification.dispatch (modules/notifications/delivery.py; P45, P49, N5) on agrotrace_test_django:
3 attempts with 1 s and 2 s pauses, a 30 s deadline per attempt, the per-send claim (`UPDATE … SET claimed_at = now()
… RETURNING claimed_at::text`), renewals and writes guarded by that exact text and `delivery_status = 'PENDING'`, a
lost claim stops the send and writes nothing, NOT_CONFIGURED / FAILED without an attempt, the `fresh`/`stale`
predicates, the sweeper, and the holder rule (no pool connection held across an attempt)."""

from __future__ import annotations

import dataclasses
import json
import threading
import time

import pytest

from agrotrace.core import sql
from agrotrace.infra import mailer
from agrotrace.infra.telegram import Telegram
from agrotrace.modules.notifications import delivery
from agrotrace.modules.notifications.delivery import DeliveryRow
from tests.world import World

PAYLOAD = {"complaintId": "c1", "batchId": "b1", "publicCode": "AT-2026-990001", "productName": "Доставка"}
TG_OFF = Telegram(None)


class FakeTelegram(Telegram):
    def __init__(self) -> None:
        super().__init__("token")
        self.sent: list[tuple[str, str]] = []

    def send_message(self, chat_id: str, text: str) -> None:
        self.sent.append((chat_id, text))


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


@pytest.fixture
def user(world):
    return world.user(world.org("FARM"))


def _row(user_id: str, channel: str = "EMAIL", *, attempts: int = 0, created: str = "now()",
         claimed: str = "NULL") -> str:
    return sql.scalar(
        "INSERT INTO notifications (user_id, type, payload, channel, delivery_status, attempts, created_at, claimed_at) "
        f"VALUES (%s, 'COMPLAINT', %s::jsonb, %s, 'PENDING', %s, {created}, {claimed}) RETURNING id::text",
        [user_id, json.dumps(PAYLOAD), channel, attempts])


def _state(nid: str) -> dict:
    return sql.one("SELECT delivery_status, attempts, claimed_at::text AS stamp FROM notifications WHERE id = %s",
                   [nid])


def _no_sleep(monkeypatch) -> list[float]:
    pauses: list[float] = []
    monkeypatch.setattr(delivery, "_sleep", pauses.append)
    return pauses


def _mem_row(channel: str = "EMAIL", chat: str | None = None, attempts: int = 0) -> DeliveryRow:
    return DeliveryRow(id="n1", type="COMPLAINT", payload=PAYLOAD, channel=channel, email="a@agrotrace.test",
                       telegram_chat_id=chat, attempts=attempts)


# ── send_row (no database) ──

def test_three_attempts_with_pauses_of_1_and_2_seconds(monkeypatch):
    pauses = _no_sleep(monkeypatch)
    calls, progress = [], []

    def fail(to, subject, text):
        calls.append((to, subject))
        raise OSError("smtp down")

    out = delivery.send_row(_mem_row(), mail_configured=True, tg=TG_OFF, send_email=fail, on_failure=progress.append)
    assert out == delivery.Outcome("FAILED", 3)
    assert len(calls) == 3 and pauses == [1, 2] and progress == [1, 2]
    assert "AT-2026-990001" in calls[0][1]


def test_the_budget_continues_after_a_previous_sender(monkeypatch):
    pauses = _no_sleep(monkeypatch)
    sent = []
    out = delivery.send_row(_mem_row(attempts=2), mail_configured=True, tg=TG_OFF,
                            send_email=lambda *a: (_ for _ in ()).throw(OSError("x")))
    assert out == delivery.Outcome("FAILED", 3) and pauses == []
    out = delivery.send_row(_mem_row(attempts=1), mail_configured=True, tg=TG_OFF, send_email=lambda *a: sent.append(a))
    assert out == delivery.Outcome("DELIVERED", 2) and len(sent) == 1
    assert delivery.send_row(_mem_row(attempts=3), mail_configured=True, tg=TG_OFF) == delivery.Outcome("FAILED", 3)


def test_an_attempt_that_does_not_finish_fails_at_its_deadline(monkeypatch):
    _no_sleep(monkeypatch)
    release = threading.Event()
    t0 = time.monotonic()
    out = delivery.send_row(_mem_row(), mail_configured=True, tg=TG_OFF, send_email=lambda *a: release.wait(10),
                            attempt_timeout_s=0.2)
    release.set()
    assert out == delivery.Outcome("FAILED", 3)
    assert 0.6 <= time.monotonic() - t0 < 3
    # The production bounds: smtplib's socket timeout below the attempt deadline (Future.result(timeout=30)).
    assert mailer.EMAIL_TIMEOUT == 10 and delivery.ATTEMPT_TIMEOUT_S == 30
    assert delivery.send_row.__kwdefaults__["attempt_timeout_s"] == 30
    with pytest.raises(delivery.AttemptTimeout):
        delivery.with_deadline(lambda: time.sleep(1), 0.05)


def test_channels_not_configured_and_unlinked_telegram_make_no_attempt():
    boom = lambda *a: pytest.fail("no attempt expected")  # noqa: E731
    assert delivery.send_row(_mem_row("TELEGRAM", chat="42"), mail_configured=True, tg=TG_OFF) == \
        delivery.Outcome("NOT_CONFIGURED", 0)
    assert delivery.send_row(_mem_row("EMAIL"), mail_configured=False, tg=TG_OFF, send_email=boom) == \
        delivery.Outcome("NOT_CONFIGURED", 0)
    tg = FakeTelegram()
    assert delivery.send_row(_mem_row("TELEGRAM", chat=None), mail_configured=True, tg=tg) == \
        delivery.Outcome("FAILED", 0)
    assert delivery.send_row(_mem_row("TELEGRAM", chat="42"), mail_configured=True, tg=tg) == \
        delivery.Outcome("DELIVERED", 1)
    assert tg.sent and tg.sent[0][0] == "42" and "AT-2026-990001" in tg.sent[0][1]


def test_no_smtp_host_means_not_configured(monkeypatch):
    from agrotrace.core import config

    real = config.get()
    monkeypatch.setattr(config, "get", lambda: dataclasses.replace(real, SMTP_HOST=None))
    assert mailer.configured() is False


# ── claims and writes (database) ──

def test_the_claim_returns_the_exact_text_stamp_and_every_write_is_guarded_by_it(user, monkeypatch):
    nid = _row(user)
    stamps = []

    def send(to, subject, text):
        stamps.append(_state(nid)["stamp"])

    out = delivery.deliver_one(nid, "fresh", tg=TG_OFF, mail_configured=True, send_email=send)
    assert out == delivery.Outcome("DELIVERED", 1)
    st = _state(nid)
    assert st["delivery_status"] == "DELIVERED" and st["attempts"] == 1
    # The stamp is the column's text with microseconds (never a Python datetime): the renewal before attempt 1
    # matched the claim's text exactly, and the final write matched the renewal's.
    assert stamps and stamps[0] == st["stamp"] and "." in st["stamp"]
    assert "RETURNING n.id, n.type, n.payload, n.channel, n.attempts, n.user_id, n.claimed_at::text AS stamp" in \
        delivery._CLAIM
    assert delivery._GUARD == ("WHERE id = %s AND delivery_status = 'PENDING' AND claimed_at = %s::timestamptz")
    assert "RETURNING claimed_at::text" in delivery._RENEW


def test_a_claim_lost_before_attempt_2_stops_the_send_and_writes_nothing(user, monkeypatch, other_session):
    nid = _row(user)
    sends = []

    def steal(_seconds):
        other_session.execute("UPDATE notifications SET claimed_at = now() + interval '1 second' WHERE id = %s", [nid])

    monkeypatch.setattr(delivery, "_sleep", steal)

    def fail(*a):
        sends.append(a)
        raise OSError("refused")

    assert delivery.deliver_one(nid, "fresh", tg=TG_OFF, mail_configured=True, send_email=fail) is None
    st = _state(nid)
    assert len(sends) == 1
    assert st["delivery_status"] == "PENDING" and st["attempts"] == 1  # the progress of attempt 1 only


def test_fresh_skips_a_live_claim_stale_takes_only_abandoned_rows(user):
    live = _row(user, claimed="now() - interval '1 minute'")
    abandoned = _row(user, attempts=1, created="now() - interval '10 minutes'", claimed="now() - interval '6 minutes'")
    young = _row(user)  # created now, never claimed: its sender may still be on its way
    assert delivery.claim_one(live, "fresh") is None
    assert delivery.claim_one(young, "stale") is None
    assert delivery.claim_one(live, "stale") is None
    row, stamp = delivery.claim_one(abandoned, "stale")
    assert row.attempts == 1 and row.email.endswith("@agrotrace.test") and stamp == _state(abandoned)["stamp"]
    assert delivery.claim_one(abandoned, "fresh") is None  # claimed a moment ago


def test_the_sweeper_sends_abandoned_rows_within_their_budget(user, monkeypatch):
    abandoned = _row(user, attempts=1, created="now() - interval '10 minutes'", claimed="now() - interval '6 minutes'")
    busy = _row(user, created="now() - interval '10 minutes'", claimed="now()")
    sent = []
    monkeypatch.setattr(mailer, "send_once", lambda to, subject, text: sent.append(subject))
    monkeypatch.setattr(mailer, "configured", lambda: True)
    assert delivery.sweep() >= 1
    assert _state(abandoned)["delivery_status"] == "DELIVERED" and _state(abandoned)["attempts"] == 2
    assert _state(busy)["delivery_status"] == "PENDING" and _state(busy)["attempts"] == 0
    assert any("AT-2026-990001" in s for s in sent)


def test_fresh_delivery_runs_on_the_send_slots_and_holds_no_connection_across_an_attempt(user, monkeypatch):
    ids = [_row(user) for _ in range(4)]
    held: list[bool] = []
    threads: set[str] = set()
    real = delivery.with_deadline

    def watched(fn, timeout_s):
        held.append(sql.holds_connection())
        threads.add(threading.current_thread().name)
        return real(fn, timeout_s)

    monkeypatch.setattr(delivery, "with_deadline", watched)
    monkeypatch.setattr(mailer, "send_once", lambda *a: time.sleep(0.05))
    monkeypatch.setattr(mailer, "configured", lambda: True)
    delivery.deliver(ids, mode="fresh")
    assert delivery.idle(10)
    assert [_state(i)["delivery_status"] for i in ids] == ["DELIVERED"] * 4
    assert held == [False] * 4
    assert threads and all(t.startswith("notify-send") for t in threads) and len(threads) <= 2


def test_a_stale_tick_claims_no_new_row_after_its_budget(monkeypatch):
    """Review M2: a hung SMTP server ends the beat tick after ~4 minutes (and with it the advisory key)."""
    taken = []
    monkeypatch.setattr(delivery, "deliver_one", lambda i, mode: (taken.append((i, mode)), time.sleep(0.2)))
    assert delivery.deliver(["a", "b", "c", "d", "e"], mode="stale", budget_s=0.3) == 2
    assert taken == [("a", "stale"), ("b", "stale")]
    assert delivery.SWEEP_TICK_BUDGET_S == 240 and delivery.sweep.__defaults__ == (240,)
