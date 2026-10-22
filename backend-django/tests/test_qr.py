"""QR rendering (infra/qr.py, infra/pdf.py): the PNG is 1024 × 1024 and decodes to the public URL's QR at level M; the PDF
is ONE A6 page (105 × 148 mm) with one label as contracts/openapi/paths/batches.yaml describes it (createBatchQr,
Ruling Q1 — not the spec's A4 3 × 8 sheet): the QR image, publicCode, the product and the organization, Cyrillic set in
Onest (the text is extracted from the PDF). Rendering runs in the QR Lane, out of process."""

from __future__ import annotations

import io
import os

from PIL import Image

from agrotrace.infra import qr

URL = "http://react-django.localhost/p/AT-2026-000123"
LABEL = ("AT-2026-000123", "Говядина охлаждённая «Мраморная»", "КФХ Петров И. С. — № 7")


def _pdf(data: bytes):
    import pypdf

    return pypdf.PdfReader(io.BytesIO(data))


def test_png_is_1024_square_black_on_white_with_a_quiet_zone():
    png = qr.qr_png(URL)
    img = Image.open(io.BytesIO(png))
    assert img.format == "PNG" and img.size == (1024, 1024)
    grey = img.convert("L")
    assert set(grey.getdata()) <= {0, 255}
    # The 4-module quiet zone: the border is white, the finder pattern starts right after it.
    import segno

    n = len(segno.make(URL, error="m", boost_error=False).matrix)
    module = 1024 / (n + 8)
    assert grey.getpixel((int(module * 2), int(module * 2))) == 255
    assert grey.getpixel((int(module * 4.5), int(module * 4.5))) == 0
    assert grey.getpixel((1023, 1023)) == 255


def test_qr_level_m_smallest_version():
    import segno

    code = segno.make(URL, error="m", boost_error=False)
    assert code.error == "M" and not code.is_micro
    assert code.version == segno.make(URL, error="m", boost_error=False, version=None).version


def test_pdf_is_one_a6_page_with_the_label_in_onest():
    png = qr.qr_png(URL)
    from agrotrace.infra.pdf import qr_label_pdf

    pdf = qr_label_pdf(public_code=LABEL[0], product_name=LABEL[1], origin_name=LABEL[2], png=png,
                       created_at_iso="2026-10-22T01:02:03.000Z")
    assert pdf[:5] == b"%PDF-"
    reader = _pdf(pdf)
    assert len(reader.pages) == 1
    page = reader.pages[0]
    w_mm = float(page.mediabox.width) * 25.4 / 72
    h_mm = float(page.mediabox.height) * 25.4 / 72
    assert abs(w_mm - 105) < 0.5 and abs(h_mm - 148) < 0.5
    text = page.extract_text()
    flat = " ".join(text.split())
    for part in LABEL:
        assert " ".join(part.split()) in flat, (part, flat)
    assert "Сканируйте, чтобы узнать происхождение партии" in flat
    fonts = set()
    res = page["/Resources"]
    for f in res["/Font"].values():
        fonts.add(str(f.get_object()["/BaseFont"]))
    assert fonts and all("Onest" in f for f in fonts), fonts
    images = page.images
    assert len(images) == 1  # the QR


def test_render_runs_in_the_lane_and_returns_both():
    png, pdf = qr.render(URL, *LABEL, "2026-10-22T01:02:03.000Z", cancelled=lambda: False)
    assert Image.open(io.BytesIO(png)).size == (1024, 1024) and pdf[:5] == b"%PDF-"
    assert qr.lane().size == 0
    assert qr.lane()._executor is not None
    pids = [p.pid for p in (qr.lane()._executor._processes or {}).values()]
    assert pids and os.getpid() not in pids


def test_public_page_url():
    assert qr.public_page_url("http://x.localhost/", "AT-2026-000001") == "http://x.localhost/p/AT-2026-000001"
    assert qr.public_page_url("https://h/base", "AT-2026-000001") == "https://h/base/p/AT-2026-000001"


def test_create_holds_no_pool_connection_while_rendering_and_storing(db, monkeypatch):
    """P61: createBatchQr reads, then renders in the Lane and writes MinIO with no connection checked out; only then
    the transaction (stopped here at its first statement)."""
    from agrotrace.core import sql
    from agrotrace.modules.batches import qr as batch_qr
    from agrotrace.security.jwt import Principal

    p = Principal(user_id="00000000-0000-4000-8000-000000000001", org_id="00000000-0000-4000-8000-000000000002",
                  roles=("RETAILER",), org_admin=True)
    batch = {"id": "00000000-0000-4000-8000-000000000003", "public_code": "AT-2026-000123", "status": "OnSale",
             "kind": "RAW", "holder_org_id": p.org_id, "origin_org_id": p.org_id,
             "product_id": "00000000-0000-4000-8000-000000000004"}
    held: dict[str, bool] = {}

    def visible(principal, batch_id):
        sql.scalar("SELECT 1")
        return batch

    def render(*args, **kwargs):
        held["render"] = sql.holds_connection()
        return b"png", b"%PDF-"

    def store(prepared):
        held.setdefault("store", sql.holds_connection())

    class Stop(Exception):
        pass

    def lock(tx, principal, batch_id):
        raise Stop

    real_one = sql.one
    monkeypatch.setattr(batch_qr, "visible_batch", visible)
    monkeypatch.setattr(batch_qr.sql, "one", lambda q, params=None: {"product_name": "Пшеница", "origin_name": "КФХ"}
                        if "FROM products pr" in q else real_one(q, params))
    monkeypatch.setattr(batch_qr.qr_render, "render", render)
    monkeypatch.setattr(batch_qr.files, "store_objects", store)
    monkeypatch.setattr(batch_qr, "lock_visible_batch", lock)
    try:
        batch_qr.create(p, batch["id"])
    except Stop:
        pass
    assert held == {"render": False, "store": False}
