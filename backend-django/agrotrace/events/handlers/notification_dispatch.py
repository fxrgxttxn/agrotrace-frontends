"""
The `notification.dispatch` handler (worker; contracts/events/notification.dispatch.schema.json, R56), the port of
backend-express/src/events/consumers/notification-dispatch.ts: in ONE transaction that starts with the
processed_events claim, the recipients are expanded and the rows inserted (modules/notifications/dispatch.py — IN_APP
DELIVERED, whose trigger emits pg_notify for SSE, and EMAIL/TELEGRAM PENDING); after the commit the PENDING rows go to
the worker's send slots (modules/notifications/delivery.py, `mode='fresh'`) and the event is acknowledged without
waiting for them. A redelivered event finds its claim and creates and sends nothing.

The worker's lifecycle hooks of the delivery half live here (this module is imported by the worker only): on
`worker_ready` the Telegram poller starts (only with a bot token — on the stand the worker has none, P14/P51); on
`worker_shutdown` the poller stops and the sends in flight finish before the process exits.
"""

from __future__ import annotations

import logging
from typing import Any

from celery.signals import worker_ready, worker_shutdown

from agrotrace.core.tx import Tx, with_tx
from agrotrace.events.claim import claim
from agrotrace.events.tasks import event_task
from agrotrace.infra import telegram
from agrotrace.modules.notifications import delivery
from agrotrace.modules.notifications.dispatch import insert_notifications

log = logging.getLogger("agrotrace.events")


def handle(envelope: dict[str, Any]) -> list[str]:
    """The ids of the PENDING (EMAIL/TELEGRAM) rows written."""
    data = envelope["data"]

    def run(tx: Tx) -> list[str]:
        if not claim(tx, envelope["id"]):
            return []
        return insert_notifications(tx, notification_type=data["notificationType"],
                                    recipients=data["recipients"], payload=data["payload"])

    return with_tx(run)


@event_task("notification.dispatch")
def notification_dispatch(envelope: dict[str, Any]) -> None:
    delivery.deliver(handle(envelope), mode="fresh")


@worker_ready.connect
def _start_poller(**_: Any) -> None:
    if telegram.start_poller() is not None:
        log.info("telegram poller started")


@worker_shutdown.connect
def _stop_delivery(**_: Any) -> None:
    telegram.stop_poller()
    delivery.shutdown()
