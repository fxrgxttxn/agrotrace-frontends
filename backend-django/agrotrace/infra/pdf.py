"""
Generated PDF documents (WeasyPrint), laid out like backend-express/src/infra/pdf.ts: the A6 QR label of a batch
(createBatchQr, R43; Ruling Q1 — the contract's A6 label, not the spec's A4 3 × 8 sheet): the QR, the public code,
the product name and the origin organization, set in the design-system font Onest (the @fontsource WOFF files of the
image, `assets/fonts/onest`; their latin and cyrillic subsets are two faces of one family, Pango picks the face that
has the glyph). Runs in the QR Lane's child (infra/qr.py): no Django here.
"""

from __future__ import annotations

import base64
import html
from functools import cache
from pathlib import Path

INK = "#33291F"
TAGLINE = "Сканируйте, чтобы узнать происхождение партии"


@cache
def _font_faces() -> str:
    from agrotrace.core.config import ROOT

    files = Path(ROOT) / "assets" / "fonts" / "onest"
    faces = []
    for weight in (400, 600):
        for subset in ("latin", "cyrillic"):
            path = files / f"onest-{subset}-{weight}-normal.woff"
            faces.append(f"@font-face {{ font-family: 'Onest {subset}'; font-weight: {weight}; "
                         f"src: url('{path.as_uri()}') format('woff'); }}")
    return "\n".join(faces)


def _label_html(public_code: str, product_name: str, origin_name: str, png: bytes) -> str:
    qr = base64.b64encode(png).decode("ascii")
    e = html.escape
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>QR {e(public_code)}</title>
<meta name="author" content="AgroTrace"><meta name="generator" content="AgroTrace django">
<style>
{_font_faces()}
@page {{ size: A6 portrait; margin: 0; }}
html, body {{ margin: 0; padding: 0; }}
body {{ font-family: 'Onest latin', 'Onest cyrillic'; color: {INK}; text-align: center; }}
.qr {{ display: block; width: 220pt; height: 220pt; margin: 24pt auto 8pt; }}
.box {{ margin: 0 28pt; }}
.code {{ font-size: 16pt; font-weight: 600; line-height: 1.35; letter-spacing: 0.5pt; }}
.product {{ font-size: 12pt; font-weight: 600; line-height: 1.35; margin-top: 4pt; }}
.origin {{ font-size: 9pt; line-height: 1.35; margin-top: 2pt; }}
.tagline {{ font-size: 8pt; line-height: 1.35; margin-top: 8pt; }}
</style></head>
<body><img class="qr" src="data:image/png;base64,{qr}" alt="">
<div class="box"><div class="code">{e(public_code)}</div><div class="product">{e(product_name)}</div>
<div class="origin">{e(origin_name)}</div><div class="tagline">{TAGLINE}</div></div></body></html>"""


def qr_label_pdf(*, public_code: str, product_name: str, origin_name: str, png: bytes, created_at_iso: str) -> bytes:
    """One A6 page (105 × 148 mm): QR, public code, product, origin organization."""
    import logging

    from weasyprint import HTML

    logging.getLogger("weasyprint").setLevel(logging.ERROR)
    logging.getLogger("fontTools").setLevel(logging.ERROR)
    doc = HTML(string=_label_html(public_code, product_name, origin_name, png)).render()
    doc.metadata.created = created_at_iso
    doc.metadata.modified = created_at_iso
    return doc.write_pdf()
