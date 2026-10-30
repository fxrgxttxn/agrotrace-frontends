"""Report PDF layout (infra/pdf.py `report_pdf`, PL14): a cell taller than a page continues on the next pages under
the repeated header instead of running past the bottom margin (pdf.ts `reportPdf`)."""

from __future__ import annotations

from agrotrace.infra import pdf

HEADER = ["Дата", "Партия", "Продукт", "Тип", "Текст", "Статус", "Решение", "Инспектор", "Решена"]


def _render(text: str, monkeypatch) -> tuple[bytes, list[float]]:
    ys: list[float] = []
    original = pdf._Writer.text

    def spy(self, line, weight, size, x, y):
        ys.append(y)
        return original(self, line, weight, size, x, y)

    monkeypatch.setattr(pdf._Writer, "text", spy)
    out = pdf.report_pdf(title="Жалобы", period_line="Период: 2026-10-01 — 2026-10-30 (UTC)",
                         generated_line="Сформирован: 2026-10-30 09:00 UTC",
                         generated_at_iso="2026-10-30T09:00:00.000Z",
                         sheets=[("Жалобы", HEADER, [["2026-10-30", "AT-2026-000001", "Молоко", "Качество", text,
                                                      "NEW", "", "", ""]])])
    return out, ys


def test_a_2000_character_cell_continues_over_the_next_pages(monkeypatch):
    short, _ = _render("коротко", monkeypatch)
    tall, ys = _render(("жалоба " * 286)[:2000], monkeypatch)
    assert max(ys) <= pdf.A4_LANDSCAPE[1] - pdf.MARGIN - pdf.TABLE_SIZE * pdf.LINE
    assert tall.count(b"/Type /Page") - tall.count(b"/Type /Pages") >= 2
    assert short.count(b"/Type /Page") - short.count(b"/Type /Pages") == 1
