"""
Batch QR (createBatchQr, downloadBatchQr; FR-PROD-08, R43, R44), the port of backend-express/src/modules/batches/qr.ts.
Who may: role PROCESSOR or RETAILER (x-roles), the organization holds the batch (403 NOT_HOLDER), and the status allows
it — Accepted or OnSale, or Approved for a DERIVED batch the PROCESSOR's organization both originates and holds (403
BATCH_STATUS {status}).

Generation renders the PNG (QR of `{PUBLIC_BASE_URL}/p/{publicCode}`) and the A6 PDF label in the QR Lane (out of
process, no pool connection held — P61), stores both in MinIO as files of kind QR (`{publicCode}.png` / `.pdf`) BEFORE
the transaction (P8), then — over the batch row locked FOR NO KEY UPDATE, the checks repeated (R47) — inserts the rows,
points the batch at them and soft-deletes the previous QR files (their URLs answer 404). `qrGeneratedAt` = the
transaction's now; the batch version does not change.
"""

from __future__ import annotations

import uuid
from typing import Any

from agrotrace.core import audit, config, sql
from agrotrace.core.problem import AppProblem
from agrotrace.core.render import iso, iso_or_null
from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import file_urls
from agrotrace.infra import qr as qr_render
from agrotrace.modules.batches.services import lock_visible_batch, not_holder, visible_batch
from agrotrace.modules.files import services as files
from agrotrace.security.jwt import Principal


def qr_denied(p: Principal, b: dict[str, Any]) -> AppProblem | None:
    """None — `p` may create/download the QR of this (visible) batch; otherwise the 403."""
    if b["holder_org_id"] != p.org_id:
        return not_holder()
    allowed = b["status"] in ("Accepted", "OnSale") or (
        b["status"] == "Approved" and b["kind"] == "DERIVED" and b["origin_org_id"] == p.org_id
        and "PROCESSOR" in p.roles)
    if allowed:
        return None
    return AppProblem(403, "FORBIDDEN", title="Batch status does not allow QR",
                      params={"reason": "BATCH_STATUS", "status": b["status"]})


def public_url(public_code: str) -> str:
    return qr_render.public_page_url(config.get().PUBLIC_BASE_URL, public_code)


def _prepared(owner_id: str, name: str, mime: str, body: bytes, created) -> files.Prepared:
    file_id = str(uuid.uuid4())
    p = files.Prepared(id=file_id, kind="QR", owner_id=owner_id, original_name=name, mime=mime, original=body)
    p.objects = [(files.object_key("QR", file_id, created, "original"), body, mime)]
    return p


def create(p: Principal, batch_id: str) -> dict[str, Any]:
    pre = visible_batch(p, batch_id)
    denied = qr_denied(p, pre)
    if denied:
        raise denied
    names = sql.one("SELECT pr.name AS product_name, (SELECT o.name FROM organizations o WHERE o.id = %s) AS origin_name "
                    "FROM products pr WHERE pr.id = %s", [pre["origin_org_id"], pre["product_id"]])
    assert names is not None
    url = public_url(pre["public_code"])
    # The object key's month and the label's date: the DB clock (P43), read before the objects are written.
    created = sql.scalar("SELECT now()")
    try:
        png, pdf = qr_render.render(url, pre["public_code"], names["product_name"], names["origin_name"] or "",
                                    iso(created))
    except qr_render.QrBusy:
        raise AppProblem(503, "BACKEND_UNAVAILABLE", headers={"Retry-After": "1"}) from None
    png_file = _prepared(p.user_id, f"{pre['public_code']}.png", "image/png", png, created)
    pdf_file = _prepared(p.user_id, f"{pre['public_code']}.pdf", "application/pdf", pdf, created)
    files.store_objects(png_file)
    files.store_objects(pdf_file)

    def run(tx: Tx) -> None:
        b = lock_visible_batch(tx, p, batch_id)
        again = qr_denied(p, b)
        if again:
            raise again
        files.insert(tx, png_file)
        files.insert(tx, pdf_file)
        now = tx.now
        tx.execute("UPDATE batches SET qr_png_file_id = %s, qr_pdf_file_id = %s, qr_generated_at = %s WHERE id = %s",
                   [png_file.id, pdf_file.id, now, batch_id])
        for f in (png_file, pdf_file):
            audit.record(tx, action="createBatchQr", entity_type="file", entity_id=f.id, actor=p,
                         diff=audit.audit_diff(None, files.audit_view(f)))
        audit.record(tx, action="createBatchQr", entity_type="batch", entity_id=batch_id, actor=p, diff=audit.audit_diff(
            {"qrPngFileId": b["qr_png_file_id"], "qrPdfFileId": b["qr_pdf_file_id"],
             "qrGeneratedAt": iso_or_null(b["qr_generated_at"])},
            {"qrPngFileId": png_file.id, "qrPdfFileId": pdf_file.id, "qrGeneratedAt": iso(now)}))
        for old in (b["qr_png_file_id"], b["qr_pdf_file_id"]):
            if files.soft_delete(tx, old, now):
                audit.record(tx, action="createBatchQr", entity_type="file", entity_id=old, actor=p,
                             diff={"deletedAt": [None, iso(now)]})

    with_tx(run)
    return {"publicUrl": url, "pngUrl": file_urls.signed(png_file.id), "pdfUrl": file_urls.signed(pdf_file.id)}


def download(request, p: Principal, batch_id: str, fmt: str):
    """downloadBatchQr: checks 1–3 as createBatchQr, then no QR yet → 404; the stored bytes (ETag = their sha256)."""
    b = visible_batch(p, batch_id)
    denied = qr_denied(p, b)
    if denied:
        raise denied
    file_id = b["qr_png_file_id"] if fmt == "png" else b["qr_pdf_file_id"]
    f = files.live_file(file_id) if file_id else None
    if f is None:
        raise AppProblem(404, "NOT_FOUND", title="QR not generated")
    return files.serve(request, f, 480, files.CACHE_PRIVATE, f'inline; filename="{b["public_code"]}.{fmt}"')
