"""
The `rating.recalculate` handler (worker; contracts/events/rating.recalculate.schema.json, BR-09), the port of
backend-express/src/events/consumers/rating-recalculate.ts: in ONE transaction that starts with the processed_events
claim, the farm's rating is recomputed from scratch under its row lock (modules/rating/services.py). `cause` and
`sourceId` are informational only.
"""

from __future__ import annotations

from typing import Any

from agrotrace.core.tx import Tx, with_tx
from agrotrace.events.claim import claim
from agrotrace.events.tasks import event_task
from agrotrace.modules.rating import services as rating


def handle(envelope: dict[str, Any]) -> None:
    def run(tx: Tx) -> None:
        if claim(tx, envelope["id"]):
            rating.recalculate(tx, envelope["data"]["organizationId"])

    with_tx(run)


@event_task("rating.recalculate")
def rating_recalculate(envelope: dict[str, Any]) -> None:
    handle(envelope)
