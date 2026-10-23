"""
The `lab.escalate` handler (worker; contracts/events/lab.escalate.schema.json, R56), the port of
backend-express/src/events/consumers/lab-escalate.ts: LAB_OVERDUE for the heads of the laboratory and every inspector
(contracts/rules/notifications.json), exactly like notification.dispatch, in ONE transaction that starts with the
processed_events claim (a redelivered event finds its claim and writes nothing). Payload: the event's data plus the
laboratory's name. The PENDING EMAIL/TELEGRAM rows are sent by the delivery half (Task 12).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core.tx import Tx, with_tx
from agrotrace.events.claim import claim
from agrotrace.events.tasks import event_task
from agrotrace.modules.notifications.dispatch import insert_notifications


def handle(envelope: dict[str, Any]) -> list[str]:
    data = envelope["data"]

    def run(tx: Tx) -> list[str]:
        if not claim(tx, envelope["id"]):
            return []
        name = tx.scalar("SELECT name FROM organizations WHERE id = %s", [data["labOrgId"]])
        return insert_notifications(
            tx, notification_type="LAB_OVERDUE",
            recipients={"userIds": [], "orgIds": [], "orgHeadIds": [data["labOrgId"]], "roles": ["INSPECTOR"]},
            payload={"labTestId": data["labTestId"], "batchId": data["batchId"], "publicCode": data["publicCode"],
                     "labOrgId": data["labOrgId"], "labName": name or "", "dueAt": data["dueAt"]})

    return with_tx(run)


@event_task("lab.escalate")
def lab_escalate(envelope: dict[str, Any]) -> None:
    handle(envelope)
