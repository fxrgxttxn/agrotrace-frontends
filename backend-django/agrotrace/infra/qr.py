"""
QR code of a batch (createBatchQr, R43, R44), the port of backend-express/src/infra/qr.ts: the public page URL
`{PUBLIC_BASE_URL}/p/{publicCode}` at error correction level M, 1024 × 1024 px, black on white, a 4-module quiet zone
(the seed's parameters). The PNG and the A6 PDF label (infra/pdf.py) are rendered together by `render_label` in the
QR Lane — out of the api process, at most 2 at a time — so the CPU work never runs on a request thread and the wait
holds no pool connection (P61).

This module and infra/pdf.py run in the Lane's child: standard library, segno, Pillow and WeasyPrint only (no Django).
"""

from __future__ import annotations

import io
from collections.abc import Callable

QR_SIZE_PX = 1024
QUIET_ZONE = 4

#: The QR Lane (Ruling Q1 lesson: label rendering is CPU work): 2 renders at a time, a deep queue like the raster lane.
LANE_RUNNING = 2
LANE_WAITING = 64
LANE_DEADLINE_S = 60.0
LANE_MEMORY_MB = 1024


def public_page_url(public_base_url: str, public_code: str) -> str:
    """`{PUBLIC_BASE_URL}/p/{publicCode}` (QrLinks.publicUrl; the base may carry a path, never a trailing `/`, R50)."""
    return f"{public_base_url.rstrip('/')}/p/{public_code}"


def qr_png(url: str) -> bytes:
    """The QR symbol of `url` (level M, the smallest version), scaled to exactly 1024 × 1024 with its quiet zone."""
    import segno
    from PIL import Image

    code = segno.make(url, error="m", boost_error=False, micro=False)
    rows = [bytes(0 if dark else 255 for dark in row) for row in code.matrix]
    n = len(rows)
    side = n + 2 * QUIET_ZONE
    blank = bytes([255]) * side
    pad = bytes([255]) * QUIET_ZONE
    data = blank * QUIET_ZONE + b"".join(pad + row + pad for row in rows) + blank * QUIET_ZONE
    small = Image.frombytes("L", (side, side), data)
    big = small.resize((QR_SIZE_PX, QR_SIZE_PX), Image.Resampling.NEAREST)
    buf = io.BytesIO()
    big.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def render_label(url: str, public_code: str, product_name: str, origin_name: str, created_at_iso: str
                 ) -> tuple[bytes, bytes]:
    """The Lane job: (PNG, PDF label)."""
    from agrotrace.infra.pdf import qr_label_pdf

    png = qr_png(url)
    return png, qr_label_pdf(public_code=public_code, product_name=product_name, origin_name=origin_name, png=png,
                             created_at_iso=created_at_iso)


class QrBusy(Exception):
    """The QR Lane could not take or finish the render (queue full, deadline, the client went away)."""


_lane = None


def lane():
    global _lane
    if _lane is None:
        from agrotrace.infra.lanes import Lane

        _lane = Lane("qr", max_waiting=LANE_WAITING, deadline_s=LANE_DEADLINE_S, memory_mb=LANE_MEMORY_MB,
                     max_running=LANE_RUNNING)
    return _lane


def render(url: str, public_code: str, product_name: str, origin_name: str, created_at_iso: str,
           cancelled: Callable[[], bool] | None = None) -> tuple[bytes, bytes]:
    """`render_label` in the QR Lane. QrBusy — refused, timed out, evicted or abandoned; RuntimeError — the render
    itself crashed."""
    from agrotrace.core.context import client_gone

    out = lane().run(render_label, url, public_code, product_name, origin_name, created_at_iso,
                     cancelled=cancelled or client_gone)
    if out.ok:
        return out.value
    if out.cause == "crashed":
        raise RuntimeError("QR label rendering crashed")
    raise QrBusy(out.cause or out.reason)
