/**
 * Report PDF layout (infra/pdf.ts, PL14): a cell taller than a page continues on the next pages under the repeated
 * header instead of running past the bottom margin.
 */
import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportPdf } from '../src/infra/pdf.js';

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
afterEach(() => vi.restoreAllMocks());

const input = (text: string) => ({
  title: 'Жалобы',
  periodLine: 'Период: 2026-10-01 — 2026-10-30 (UTC)',
  generatedLine: 'Сформирован: 2026-10-30 09:00 UTC',
  generatedAt: new Date('2026-10-30T09:00:00Z'),
  sheets: [
    {
      name: 'Жалобы',
      header: ['Дата', 'Партия', 'Продукт', 'Тип', 'Текст', 'Статус', 'Решение', 'Инспектор', 'Решена'],
      rows: [['2026-10-30', 'AT-2026-000001', 'Молоко', 'Качество', text, 'NEW', '', '', '']],
    },
  ],
});

describe('reportPdf', () => {
  it('a 2000-character cell continues over the next pages, no line below the bottom margin (PL14)', async () => {
    expect(pages(await reportPdf(input('коротко')))).toBe(1);
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const pdf = await reportPdf(input('жалоба '.repeat(286).slice(0, 2000)));
    const ys = text.mock.calls.map((c) => c[2] as number);
    // A4 landscape: 595.28 pt high, 28 pt margin, 7 pt text on a 9.45 pt line.
    expect(Math.max(...ys)).toBeLessThanOrEqual(595.28 - 28 - 9.45);
    expect(pages(pdf)).toBeGreaterThanOrEqual(2);
  });
});
