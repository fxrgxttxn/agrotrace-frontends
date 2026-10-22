"""
Batch documents (R81, R90, R91; getBatchDocuments, retryBatchVsdImport), the port of
backend-express/src/modules/documents/service.ts: the VSD of ФГИС «Меркурий» (the `batch_documents` row of kind VSD),
the protocols of the batch's lab tests the caller may see, and the QR links when the caller may download the QR. The
import itself runs in the worker (events/handlers/vsd_import.py).
"""

from __future__ import annotations

from typing import Any

from agrotrace.core import audit, sql
from agrotrace.core.problem import AppProblem
from agrotrace.core.render import iso, iso_or_null
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import file_urls, outbox
from agrotrace.modules.batches import qr
from agrotrace.modules.batches.mappers import org_ref
from agrotrace.modules.batches.services import invalid_transition, lock_visible_batch, not_holder, visible_batch
from agrotrace.modules.batches.visibility import is_participant, sees_all
from agrotrace.modules.files import services as files
from agrotrace.security.jwt import Principal

#: contracts/rules/entity-state-machines.json `vsdImport`: retryBatchVsdImport restarts only these.
RETRYABLE = ("NOT_FOUND", "FAILED")

_VSD_COLUMNS = ("id::text AS id, import_status, external_uuid::text AS external_uuid, number, issue_date, vsd_status, "
                "payload, attempts, last_error, created_at, updated_at")


def vsd_view(d: dict[str, Any]) -> dict[str, Any]:
    """`BatchVsd`: the imported document only for IMPORTED."""
    payload = sql.jsonb(d["payload"])
    document = None
    if d["import_status"] == "IMPORTED" and payload:
        product = payload.get("product") or {}
        document = {
            "externalUuid": d["external_uuid"],
            "number": d["number"],
            "issueDate": d["issue_date"].isoformat() if d["issue_date"] is not None else None,
            "status": d["vsd_status"],
            "productName": product.get("name", ""),
            "volume": payload.get("volume") or {"value": 0, "unit": ""},
            "consignor": payload.get("consignor") or {"inn": "", "name": ""},
            "consignee": payload.get("consignee") or {"inn": "", "name": ""},
        }
    return {"id": d["id"], "importStatus": d["import_status"], "document": document, "attempts": d["attempts"],
            "requestedAt": iso(d["created_at"]), "updatedAt": iso(d["updated_at"])}


def get_documents(p: Principal, batch_id: str) -> dict[str, Any]:
    """getBatchDocuments — visibility as getBatch; contents filtered by the caller's rights (R91, the union of roles):
    `labProtocols` — INSPECTOR/ADMIN all, participants all tests of a visible batch, LAB its own laboratory's; `qr` —
    only for whoever may download it (downloadBatchQr)."""
    b = visible_batch(p, batch_id)
    vsd = sql.one(f"SELECT {_VSD_COLUMNS} FROM batch_documents WHERE batch_id = %s AND kind = 'VSD'", [batch_id])
    own_lab_only = not sees_all(p) and not is_participant(p)
    protocols = sql.all(
        "SELECT t.id::text AS id, t.reason, t.conclusion, t.completed_at, l.id::text AS lab_id, l.name AS lab_name, "
        "l.type AS lab_type, l.logo_file_id::text AS lab_logo, f.id::text AS file_id, f.kind AS file_kind, f.mime, "
        "f.size_bytes, f.original_name FROM lab_tests t JOIN files f ON f.id = t.protocol_file_id "
        "JOIN organizations l ON l.id = t.lab_org_id "
        "WHERE t.batch_id = %s AND t.deleted_at IS NULL AND f.deleted_at IS NULL"
        + (" AND t.lab_org_id = %s" if own_lab_only else "") + " ORDER BY t.created_at, t.id",
        [batch_id, p.org_id] if own_lab_only else [batch_id])
    links = None
    may_qr = any(r in ("PROCESSOR", "RETAILER") for r in p.roles) and qr.qr_denied(p, b) is None
    if may_qr and b["qr_png_file_id"] and b["qr_pdf_file_id"]:
        live = sql.scalar("SELECT count(*) FROM files WHERE id = ANY(%s::uuid[]) AND deleted_at IS NULL",
                          [[b["qr_png_file_id"], b["qr_pdf_file_id"]]])
        if live == 2:
            links = {"publicUrl": qr.public_url(b["public_code"]), "pngUrl": file_urls.signed(b["qr_png_file_id"]),
                     "pdfUrl": file_urls.signed(b["qr_pdf_file_id"])}
    return {
        "batchId": b["id"],
        "vsd": vsd_view(vsd) if vsd else None,
        "labProtocols": [{
            "labTestId": t["id"],
            "lab": org_ref(t["lab_id"], t["lab_name"], t["lab_type"], t["lab_logo"]),
            "reason": t["reason"],
            "conclusion": t["conclusion"],
            "completedAt": iso_or_null(t["completed_at"]),
            "file": {"id": t["file_id"], "url": files.file_url(t["file_kind"], t["file_id"]), "mime": t["mime"],
                     "sizeBytes": int(t["size_bytes"]), "originalName": t["original_name"]},
        } for t in protocols],
        "qr": links,
    }


def retry_vsd(p: Principal, batch_id: str) -> dict[str, Any]:
    """retryBatchVsdImport — locks: the batch, then its VSD row (R52 "other rows"); 404 → 403 NOT_HOLDER → 404 no VSD →
    409 INVALID_TRANSITION {from, to: PENDING} unless NOT_FOUND/FAILED. The row back to PENDING (attempts 0, no error),
    audit, `vsd.import` in the outbox (published after the commit; the intermediate attempts are never audited)."""

    def run(tx: Tx) -> dict[str, Any]:
        b = lock_visible_batch(tx, p, batch_id)
        if b["holder_org_id"] != p.org_id:
            raise not_holder()
        doc = tx.one(f"SELECT {_VSD_COLUMNS} FROM batch_documents WHERE batch_id = %s AND kind = 'VSD' "
                     "FOR NO KEY UPDATE", [batch_id])
        if doc is None:
            raise AppProblem(404, "NOT_FOUND")
        if doc["import_status"] not in RETRYABLE:
            raise invalid_transition(doc["import_status"], "PENDING")
        updated = tx.one("UPDATE batch_documents SET import_status = 'PENDING', attempts = 0, last_error = NULL "
                         f"WHERE id = %s RETURNING {_VSD_COLUMNS}", [doc["id"]])
        assert updated is not None
        audit.record(tx, action="retryBatchVsdImport", entity_type="batchDocument", entity_id=doc["id"], actor=p,
                     diff=audit.audit_diff(
                         {"importStatus": doc["import_status"], "attempts": doc["attempts"],
                          "lastError": doc["last_error"]},
                         {"importStatus": "PENDING", "attempts": 0, "lastError": None}))
        outbox.enqueue(tx, "vsd.import", {"documentId": doc["id"], "batchId": batch_id,
                                          "publicCode": b["public_code"]})
        return vsd_view(updated)

    return with_tx(run)
