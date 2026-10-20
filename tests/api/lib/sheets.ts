/**
 * Import files for importDictionary (contracts/openapi/paths/dictionaries.yaml): CSV text as the contract describes
 * it (`;`, RFC 4180 quotes, CRLF or LF, optional BOM), XLSX workbooks written by exceljs (a test-side dependency, the
 * same library a backend may read them with — the files are standard OOXML) and a plain ZIP that is no workbook.
 */
import ExcelJS from 'exceljs';
import { crc32 } from './files.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_ALLOWED = ['text/csv', XLSX_MIME];
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 242 880

/** One CSV field: quoted (RFC 4180, `""` inside) when it holds `;`, `"`, CR or LF — or when `quote` is set. */
export function csvField(v: string, quote = false): string {
  return quote || /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV bytes from rows of fields (quoted where needed); `eol` CRLF or LF; `bom` prepends EF BB BF. */
export function csv(rows: string[][], opts: { eol?: '\r\n' | '\n'; bom?: boolean } = {}): Buffer {
  const eol = opts.eol ?? '\n';
  const text = rows.map((r) => r.map((f) => csvField(f)).join(';')).join(eol) + eol;
  return Buffer.concat([
    opts.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
    Buffer.from(text, 'utf8'),
  ]);
}

export type CellValue = string | number | boolean | Date | null | { error: '#N/A' | '#DIV/0!' };

/** An XLSX workbook with the given sheets (the first one is imported); `null` leaves a cell empty. */
export async function xlsx(sheets: { name: string; rows: (CellValue[] | null)[] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((row, i) => {
      if (row === null) return; // a row the sheet does not store at all
      row.forEach((v, j) => {
        if (v === null) return;
        const cell = ws.getCell(i + 1, j + 1);
        cell.value = v as ExcelJS.CellValue;
        if (v instanceof Date) cell.numFmt = 'dd.mm.yyyy';
      });
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A valid ZIP archive (stored, no compression) of `files` — e.g. a ZIP that is not an XLSX workbook. */
export function zip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
