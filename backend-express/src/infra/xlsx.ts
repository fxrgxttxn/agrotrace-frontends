/**
 * Report workbooks (downloadReport, contract `Файл` rules): one worksheet per sheet in order, named as given; row 1 —
 * the column headers in bold; data from row 2. Cell types: text — a string cell; int — a number with format `0`;
 * mass — a number with format `0.000`; dec2 — a number with format `0.00`; null — no cell value.
 */
import ExcelJS from 'exceljs';
import type { Cell, Sheet } from '../modules/reports/sheets.js';

const FORMATS = { int: '0', mass: '0.000', dec2: '0.00' } as const;

export async function writeXlsx(sheets: readonly Sheet[], createdAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AgroTrace';
  wb.created = createdAt;
  wb.modified = createdAt;
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    const head = ws.addRow(s.header);
    head.font = { bold: true };
    for (const cells of s.rows) {
      const row = ws.addRow(cells.map(value));
      cells.forEach((c, i) => {
        if (c.t !== 'text' && c.v !== null) row.getCell(i + 1).numFmt = FORMATS[c.t];
      });
    }
    ws.columns.forEach((col, i) => {
      const longest = Math.max(
        s.header[i]!.length,
        ...s.rows.slice(0, 200).map((r) => String(r[i]?.v ?? '').length),
      );
      col.width = Math.min(60, Math.max(8, longest + 2));
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function value(c: Cell): string | number | null {
  if (c.v === null) return null;
  if (c.t === 'text') return c.v;
  return typeof c.v === 'number' ? c.v : Number(c.v);
}
