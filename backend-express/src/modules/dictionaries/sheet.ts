/**
 * Reading an import file (importDictionary, R58): the type is decided by the content, never by the name or the part's
 * Content-Type —
 *
 * - a ZIP (`PK\x03\x04`) is an XLSX workbook when its central directory lists `[Content_Types].xml` and
 *   `xl/workbook.xml`; any other ZIP, a broken one or a workbook that cannot be read → 415. A workbook is read in
 *   memory within hard limits (P23): ≤ 64 archive entries, ≤ 16 MiB per entry and ≤ 32 MiB in all — declared and
 *   actually inflated —, ≤ 20 000 `<row>` elements in the sheet (empty ones included), ≤ 64 cells per row, 10 s in
 *   all; beyond any of them → 415 `{allowed, reason: "workbook-too-large"}`. No temporary file is ever written: only
 *   the parts the import needs are inflated and handed to exceljs as a new in-memory archive in which the shared
 *   strings precede the sheet;
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
import { storedZip, unzip, ZipError, zipDirectory, type ZipEntry } from '../../infra/zip.js';

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

/** P23 limits of a workbook (exported for the unit tests). */
export const XLSX_LIMITS = {
  zip: { maxEntries: 64, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 },
  maxSheetRows: 20_000,
  maxRowCells: 64,
  deadlineMs: 10_000,
};

const tooLarge = () =>
  new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', {
    params: { allowed: IMPORT_TYPES, reason: 'workbook-too-large' },
  });

export async function readSheet(bytes: Buffer, opts: { deadlineMs?: number } = {}): Promise<Sheet> {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50)
    return readXlsx(bytes, opts.deadlineMs ?? XLSX_LIMITS.deadlineMs);
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

const zipProblem = (err: unknown): AppProblem =>
  err instanceof ZipError && err.kind === 'tooLarge' ? tooLarge() : unsupported();

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const EMPTY_SST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`;

/** The archive path of the first sheet in workbook order (`xl/workbook.xml` → its relationship target). */
function firstSheetPath(workbook: string, rels: string): string | null {
  const sheet = /<(?:[\w-]+:)?sheet\b[^>]*>/.exec(workbook)?.[0];
  const rid = sheet && /\s[\w-]+:id\s*=\s*"([^"]+)"/.exec(sheet)?.[1];
  if (!rid) return null;
  for (const rel of rels.match(/<(?:[\w-]+:)?Relationship\b[^>]*>/g) ?? []) {
    if (/\sId\s*=\s*"([^"]+)"/.exec(rel)?.[1] !== rid) continue;
    const target = /\sTarget\s*=\s*"([^"]+)"/.exec(rel)?.[1];
    if (!target) return null;
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  return null;
}

/**
 * The parts of the workbook the import reads, inflated within the P23 limits, repacked (stored, in memory) as a
 * minimal workbook: the workbook part, one relationship to the first sheet, styles, shared strings (an empty table
 * when the workbook has none) and that sheet as `xl/worksheets/sheet1.xml` — in that order, so exceljs's streaming
 * reader parses the sheet directly and never buffers it to a temporary file.
 */
export function minimalWorkbook(bytes: Buffer): Buffer {
  let names: string[];
  try {
    names = zipDirectory(bytes, XLSX_LIMITS.zip).map((e) => e.name);
  } catch (err) {
    throw zipProblem(err);
  }
  if (!names.includes('[Content_Types].xml') || !names.includes('xl/workbook.xml')) throw unsupported();
  const part = (entries: ZipEntry[], name: string) => entries.find((e) => e.name === name)?.data;
  let meta: ZipEntry[];
  try {
    meta = unzip(
      bytes,
      XLSX_LIMITS.zip,
      (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels',
    );
  } catch (err) {
    throw zipProblem(err);
  }
  const workbook = part(meta, 'xl/workbook.xml')!;
  const rels = part(meta, 'xl/_rels/workbook.xml.rels');
  const sheetPath = rels ? firstSheetPath(workbook.toString('utf8'), rels.toString('utf8')) : null;
  if (!sheetPath || !names.includes(sheetPath)) throw unsupported();
  let parts: ZipEntry[];
  try {
    parts = unzip(
      bytes,
      XLSX_LIMITS.zip,
      (n) => n === sheetPath || n === 'xl/styles.xml' || n === 'xl/sharedStrings.xml',
    );
  } catch (err) {
    throw zipProblem(err);
  }
  return storedZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS, 'utf8') },
    ...parts.filter((e) => e.name === 'xl/styles.xml'),
    {
      name: 'xl/sharedStrings.xml',
      data: part(parts, 'xl/sharedStrings.xml') ?? Buffer.from(EMPTY_SST, 'utf8'),
    },
    { name: SHEET_PATH, data: part(parts, sheetPath)! },
  ]);
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
 * The first worksheet of the workbook (by `xl/workbook.xml`), read from the minimal in-memory workbook. Any read error
 * → 415; a limit of P23 (rows, cells per row, the deadline) → 415 `workbook-too-large`.
 */
async function readXlsx(bytes: Buffer, deadlineMs: number): Promise<Sheet> {
  const started = Date.now();
  const minimal = minimalWorkbook(bytes);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(minimal), {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'cache',
    worksheets: 'emit',
    entries: 'ignore',
  });
  const sheet: Sheet = { header: null, rows: [], padShort: true };
  let expired = false;
  const read = async () => {
    let seen = 0;
    for await (const ws of reader) {
      let first = true;
      for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
        if (expired || Date.now() - started > deadlineMs) throw tooLarge();
        seen += 1;
        if (seen > XLSX_LIMITS.maxSheetRows) throw tooLarge();
        const values = row.values as XlsxValue[];
        if (values.length - 1 > XLSX_LIMITS.maxRowCells) throw tooLarge();
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
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        expired = true;
        reject(tooLarge());
      },
      Math.max(0, deadlineMs - (Date.now() - started)),
    );
  });
  const work = read();
  // After the deadline the reader stops at its next row; its own rejection then has nobody to report to.
  work.catch(() => undefined);
  try {
    await Promise.race([work, deadline]);
  } catch (err) {
    if (err instanceof AppProblem) throw err;
    throw unsupported();
  } finally {
    clearTimeout(timer);
  }
  return sheet;
}
