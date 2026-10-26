"""
Report PDF text extraction (infra/pdf.py ToUnicode CMap, Task 13 review M2): a character the font lacks is drawn as
.notdef (GID 0), which maps to U+0000 as pdfkit maps it (`unicode = [[0]]`) — never to another character of the text
(a wrong visible letter, or U+0001 after a control character), so copy/paste and search never show a letter that is
not there.
"""

from __future__ import annotations

import io
from collections import Counter

from pypdf import PdfReader

from agrotrace.infra.pdf import report_pdf

CYR = "Ё ё № Ѐ ӿ ґ Ӏ"
LAT = "a\x01b 😀 漢 α ب ‐ z"


def _extract(text: str) -> str:
    pdf = report_pdf(title="Тест", period_line="Период", generated_line="Сформирован",
                     generated_at_iso="2026-10-26T00:00:00.000Z", sheets=[("Лист", ["Колонка"], [[text]])])
    return "".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)


def test_missing_glyphs_extract_as_nothing_visible_never_as_another_character():
    for text in (CYR, LAT, LAT[::-1]):
        got = _extract(text)
        expected = Counter(text) + Counter("AgroTrace — Тест Период Сформирован Лист Колонка")
        for ch, n in Counter(got).items():
            if ch in "\x00 \n":
                continue
            assert n <= expected[ch], (text, ch, got)
        assert "\x01" not in got, got  # U+0001 has no glyph: it is .notdef too
