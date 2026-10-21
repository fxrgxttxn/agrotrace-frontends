/** Report rendering in the worker thread (P52): the queue answers with the file; the API thread only waits. */
import { describe, expect, it } from 'vitest';
import { renderInWorker } from '../src/modules/reports/render.js';

const job = (format: 'xlsx' | 'pdf') => ({
  format,
  report: {
    title: 'Реестр партий',
    periodLine: 'Период: 2026-01-01 — 2026-01-30 (UTC)',
    generatedLine: 'Сформирован: 2026-01-30 10:00 UTC',
    generatedAt: '2026-01-30T10:00:00Z',
    sheets: [
      {
        name: 'Партии',
        header: ['Код партии', 'Масса, кг'],
        rows: [
          [
            { t: 'text' as const, v: 'AT-2026-000001' },
            { t: 'mass' as const, v: '12.345' },
          ],
        ],
      },
    ],
  },
});

describe('renderInWorker', () => {
  it('renders XLSX (zip) and PDF in the worker thread', async () => {
    const x = await renderInWorker(job('xlsx'));
    expect(x.subarray(0, 2).toString('latin1')).toBe('PK');
    const p = await renderInWorker(job('pdf'));
    expect(p.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60_000);
});
