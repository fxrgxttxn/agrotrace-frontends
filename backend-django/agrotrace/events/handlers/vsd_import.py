"""
The `vsd.import` handler (R81, contracts/events/vsd.import.schema.json; worker process), the port of
backend-express/src/modules/documents/vsd-import.ts:

1. The event already claimed (`processed_events`) or the row no longer PENDING — nothing to do (a row other than
   PENDING still gets the claim, in an otherwise empty transaction).
2. The query from the batch: productCode = products.mercury_code (NULL → NOT_FOUND without calling Mercury),
   senderInn = the origin organization's INN, dateFrom/dateTo = the UTC dates of harvested_at ∓ 3 days.
3. Up to 6 calls: a failed call records attempts + 1 and last_error in its own short statement (only while the row is
   still PENDING) and the next call follows after 2, 4, 8, 16, 32 s (MERCURY_RETRY_BASE_MS doubling). No connection is
   held during a call or a pause (P61).
4. The final state (IMPORTED with the latest CONFIRMED document, NOT_FOUND, FAILED after the 6th failure) in ONE
   transaction that starts with the claim, locks the row FOR NO KEY UPDATE and writes only while it is still PENDING,
   with the audit row `system.vsdImport` (entityType batchDocument); `updated_at` comes from the touch trigger.

Mercury being down is never a handler failure: the message is acknowledged after FAILED. The batch is never touched.
The Mercury settings (P35, incl. the test stand's MERCURY_FAIL_* and MERCURY_RETRY_BASE_MS) are read when the worker
starts (this module is imported by the worker at start).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from agrotrace.core import audit, config, sql
from agrotrace.core.render import json_dumps
from agrotrace.core.tx import Tx, with_tx
from agrotrace.domain.dates import add_days_to_date, utc_date
from agrotrace.events.claim import already_claimed, claim
from agrotrace.events.tasks import event_task
from agrotrace.infra import mercury as mercury_api

log = logging.getLogger("agrotrace.vsd")

MERCURY_CALLS = 6
LAST_ERROR_MAX = 500


@dataclass(frozen=True)
class Outcome:
    status: Literal["IMPORTED", "NOT_FOUND", "FAILED"]
    calls: int
    vsd: dict[str, Any] | None = None
    error: str = ""


_client = mercury_api.from_config()
_retry_base_ms = config.get().MERCURY_RETRY_BASE_MS


def _source(document_id: str) -> dict[str, Any] | None:
    """The VSD row with what the Mercury query needs (product code, the origin's INN, harvestedAt)."""
    return sql.one(
        "SELECT d.id::text AS id, d.import_status, p.mercury_code, o.inn, b.harvested_at "
        "FROM batch_documents d JOIN batches b ON b.id = d.batch_id JOIN products p ON p.id = b.product_id "
        "JOIN organizations o ON o.id = b.origin_org_id WHERE d.id = %s", [document_id])


def _claim_only(event_id: str) -> None:
    with_tx(lambda tx: claim(tx, event_id))


def _record_failure(document_id: str, error: str) -> None:
    sql.execute("UPDATE batch_documents SET attempts = attempts + 1, last_error = %s "
                "WHERE id = %s AND import_status = 'PENDING'", [error[:LAST_ERROR_MAX], document_id])


def _finish(event_id: str, document_id: str, outcome: Outcome) -> None:
    def run(tx: Tx) -> None:
        if not claim(tx, event_id):
            return
        row = tx.one("SELECT import_status, attempts, last_error FROM batch_documents WHERE id = %s "
                     "FOR NO KEY UPDATE", [document_id])
        if row is None or row["import_status"] != "PENDING":
            return
        # The calls before the last one were counted by _record_failure; the last one is counted here.
        attempts = row["attempts"] + (1 if outcome.calls > 0 else 0)
        vsd = outcome.vsd
        if outcome.status == "IMPORTED":
            assert vsd is not None
            last_error = None
            tx.execute("UPDATE batch_documents SET import_status = 'IMPORTED', external_uuid = %s, number = %s, "
                       "issue_date = %s, vsd_status = %s, payload = %s::jsonb, attempts = %s, last_error = NULL "
                       "WHERE id = %s",
                       [vsd["uuid"], vsd["number"], vsd["issueDate"], vsd["status"], json_dumps(vsd), attempts,
                        document_id])
        else:
            last_error = outcome.error[:LAST_ERROR_MAX] if outcome.status == "FAILED" else None
            tx.execute("UPDATE batch_documents SET import_status = %s, attempts = %s, last_error = %s WHERE id = %s",
                       [outcome.status, attempts, last_error, document_id])
        imported = outcome.status == "IMPORTED" and vsd is not None
        before = {"importStatus": row["import_status"], "attempts": row["attempts"], "lastError": row["last_error"],
                  "externalUuid": None, "number": None, "issueDate": None, "vsdStatus": None}
        after = {"importStatus": outcome.status, "attempts": attempts, "lastError": last_error,
                 "externalUuid": vsd["uuid"] if imported else None, "number": vsd["number"] if imported else None,
                 "issueDate": vsd["issueDate"] if imported else None, "vsdStatus": vsd["status"] if imported else None}
        audit.record(tx, action="system.vsdImport", entity_type="batchDocument", entity_id=document_id,
                     diff=audit.audit_diff(before, after), actor=None)

    with_tx(run)


def import_vsd(event: dict[str, Any], *, client: mercury_api.Mercury | None = None, retry_base_ms: int | None = None,
               sleep: Callable[[float], None] = time.sleep) -> None:
    client = client or _client
    base_ms = _retry_base_ms if retry_base_ms is None else retry_base_ms
    event_id = event["id"]
    document_id = event["data"]["documentId"]
    if already_claimed(event_id):
        return
    src = _source(document_id)
    if src is None or src["import_status"] != "PENDING":
        _claim_only(event_id)
        return
    if src["mercury_code"] is None or src["harvested_at"] is None:
        _finish(event_id, src["id"], Outcome("NOT_FOUND", 0))
        return
    day = utc_date(src["harvested_at"])
    query = mercury_api.VsdQuery(product_code=src["mercury_code"], sender_inn=src["inn"],
                                 date_from=add_days_to_date(day, -3), date_to=add_days_to_date(day, 3))
    call = 0
    while True:
        call += 1
        r = client.list_vsd(query)
        if r.ok:
            vsd = mercury_api.pick_vsd(r.items)
            _finish(event_id, src["id"], Outcome("IMPORTED", call, vsd) if vsd else Outcome("NOT_FOUND", call))
            return
        log.warning("mercury call failed", extra={"eventId": event_id, "documentId": src["id"], "call": call,
                                                  "err": r.error})
        if call >= MERCURY_CALLS:
            _finish(event_id, src["id"], Outcome("FAILED", call, error=r.error))
            return
        _record_failure(src["id"], r.error)
        sleep(base_ms * 2 ** (call - 1) / 1000)


@event_task("vsd.import", lane="vsd")
def handle(event: dict[str, Any]) -> None:
    import_vsd(event)

