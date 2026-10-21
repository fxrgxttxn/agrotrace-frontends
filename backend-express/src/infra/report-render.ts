/**
 * Report rendering, shared by the worker thread (report-worker.ts) and unit tests: a RenderJob (plain data, structured
 * clone safe) → the file bytes.
 */
import type { Cell, Sheet } from '../modules/reports/sheets.js';
import { reportPdf } from './pdf.js';
import { writeXlsx } from './xlsx.js';

export interface RenderJob {
  format: 'xlsx' | 'pdf';
  report: {
    title: string;
    periodLine: string;
    generatedLine: string;
    /** ISO instant (the snapshot's now()). */
    generatedAt: string;
    sheets: Sheet[];
  };
}

const cellText = (c: Cell): string => (c.v === null ? '' : String(c.v));

export function renderReport(job: RenderJob): Promise<Buffer> {
  const r = job.report;
  const at = new Date(r.generatedAt);
  if (job.format === 'xlsx') return writeXlsx(r.sheets, at);
  return reportPdf({
    title: r.title,
    periodLine: r.periodLine,
    generatedLine: r.generatedLine,
    generatedAt: at,
    sheets: r.sheets.map((s) => ({
      name: s.name,
      header: s.header,
      rows: s.rows.map((row) => row.map(cellText)),
    })),
  });
}
