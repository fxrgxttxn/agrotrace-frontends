/**
 * Reading an import file (importDictionary, R58): the type is decided by the content, never by the name or the part's
 * Content-Type —
 *
 * - a ZIP (`PK\x03\x04`) is an XLSX workbook when its central directory lists `[Content_Types].xml` and
 *   `xl/workbook.xml`; any other ZIP, a broken one or a workbook that cannot be read → 415;
 * - otherwise a byte NUL → 415; invalid UTF-8 or an unclosed quote → 400 `errors.file: [validation.import.format]`;
 *   the rest is CSV: UTF-8 (a leading BOM is skipped), `;` separators, RFC 4180 quotes, CRLF or LF record ends.
 *
 * The result is the header and the data rows with their numbers (CSV: the record number; XLSX: the sheet row number;
 * the header is row 1, skipped empty rows are counted). A cell is a string, or INVALID for an XLSX cell of another
 * type (date, boolean, error) — the import reports it as `validation.pattern`. More than 10 000 non-empty data rows →
 * 400 `validation.import.tooManyRows` (reading stops there).
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { AppProblem, validationProblem } from '../../http/problem.js';

export const INVALID = Symbol('invalid cell');
export type Cell = string | typeof INVALID;
export interface SheetRow {
  number: number;
  cells: Cell[];
}
export interface Sheet {
  header: Cell[] | null;
  rows: SheetRow[];
  /** XLSX: a row narrower than the header is padded with empty cells (a sheet does not store empty cells). */
  padShort: boolean;
}

export const MAX_DATA_ROWS = 10_000;
export const IMPORT_TYPES = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

const unsupported = () =>
  new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: IMPORT_TYPES } });
const badFormat = () => validationProblem({ file: ['validation.import.format'] });
const tooManyRows = () => validationProblem({ file: ['validation.import.tooManyRows'] });

export const isEmptyRow = (cells: Cell[]): boolean => cells.every((c) => c === '');

export async function readSheet(bytes: Buffer): Promise<Sheet> {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    if (!isWorkbookZip(bytes)) throw unsupported();
    return readXlsx(bytes);
  }
  if (bytes.includes(0)) throw unsupported();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw badFormat();
  }
  return toSheet(parseCsv(text));
}

/** Header = the first record; the data rows keep their record numbers; empty rows are dropped (still counted). */
function toSheet(records: string[][]): Sheet {
  const rows: SheetRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]!;
    if (isEmptyRow(cells)) continue;
    if (rows.length === MAX_DATA_ROWS) throw tooManyRows();
    rows.push({ number: i + 1, cells });
  }
  return { header: records[0] ?? null, rows, padShort: false };
}

/**
 * RFC 4180 with `;`: a field is quoted when it starts with `"` (inside, `""` is a quote; separators and line breaks
 * are data); a quote inside an unquoted field is an ordinary character; after a closing quote only `;` or a record
 * end may follow (anything else — 400 format), and a quote left open at the end of the file — 400 format. A record
 * ends at LF or CRLF; the final line break does not start another record.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return records;
  for (;;) {
    // One field starting at i.
    let value: string;
    if (text[i] === '"') {
      let out = '';
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) throw badFormat();
        out += text.slice(j, q);
        if (text[q + 1] === '"') {
          out += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      value = out;
      i = j;
      if (i < n && text[i] !== ';' && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n'))
        throw badFormat();
    } else {
      let j = i;
      while (j < n && text[j] !== ';' && text[j] !== '\n' && !(text[j] === '\r' && text[j + 1] === '\n')) j++;
      value = text.slice(i, j);
      i = j;
    }
    record.push(value);
    if (i >= n) {
      records.push(record);
      return records;
    }
    if (text[i] === ';') {
      i += 1;
      continue;
    }
    // A record end.
    i += text[i] === '\r' ? 2 : 1;
    records.push(record);
    record = [];
    if (i >= n) return records;
  }
}

// ── XLSX ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A ZIP whose central directory names the OOXML content types and a workbook part. */
function isWorkbookZip(b: Buffer): boolean {
  // End of central directory: the last `PK\x05\x06` (a comment of up to 65 535 bytes may follow it).
  const from = Math.max(0, b.length - 22 - 65_535);
  let eocd = -1;
  for (let i = b.length - 22; i >= from; i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return false;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names = new Set<string>();
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return false;
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    if (p + 46 + nameLen > b.length) return false;
    names.add(b.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
  }
  return names.has('[Content_Types].xml') && names.has('xl/workbook.xml');
}

/** The shortest decimal text that reads back as `n` (JavaScript's own), written without an exponent. */
export function numberText(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', expS] = m;
  const digits = int! + frac;
  const point = int!.length + Number(expS);
  const body =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + body;
}

type XlsxValue = ExcelJS.CellValue | { sharedString: number } | undefined;

function cellText(v: XlsxValue): Cell {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? numberText(v) : INVALID;
  if (typeof v === 'boolean' || v instanceof Date) return INVALID;
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return INVALID;
    if ('formula' in v || 'sharedFormula' in v) {
      const result = (v as { result?: unknown }).result;
      if (result === undefined || result === null) return INVALID;
      return cellText(result as XlsxValue);
    }
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
  }
  return INVALID;
}

/** A sheet stores no empty cells: trailing empty cells are dropped (a narrower row is padded by the import). */
function trimTrailing(cells: Cell[]): Cell[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}

/**
 * The first worksheet of the workbook (by `xl/workbook.xml`; when the workbook part is stored after the sheets, the
 * first sheet stored). Any read error of the workbook → 415.
 */
async function readXlsx(bytes: Buffer): Promise<Sheet> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(bytes), {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'cache',
    worksheets: 'emit',
    entries: 'ignore',
  });
  const sheet: Sheet = { header: null, rows: [], padShort: true };
  try {
    for await (const ws of reader) {
      const wanted = (reader as unknown as { model?: { sheets?: { id: number }[] } }).model?.sheets?.[0]?.id;
      if (wanted !== undefined && Number((ws as unknown as { id: unknown }).id) !== Number(wanted)) continue;
      let first = true;
      for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
        const values = row.values as XlsxValue[];
        const cells: Cell[] = [];
        for (let col = 1; col < values.length; col++) cells.push(cellText(values[col]));
        const trimmed = trimTrailing(cells);
        if (first) {
          first = false;
          if (row.number === 1) {
            sheet.header = trimmed;
            continue;
          }
        }
        if (row.number === 1) continue;
        if (isEmptyRow(trimmed)) continue;
        if (sheet.rows.length === MAX_DATA_ROWS) throw tooManyRows();
        sheet.rows.push({ number: row.number, cells: trimmed });
      }
      break;
    }
  } catch (err) {
    if (err instanceof AppProblem) throw err;
    throw unsupported();
  }
  return sheet;
}
