/**
 * The XLSX reading of importDictionary, run inside a worker thread only (xlsx-worker.ts, P24): whatever a workbook
 * makes exceljs do happens off the API's event loop, under the worker's heap limit and the queue's deadline.
 *
 * Order (each step only after the previous one passed — the contract's precedence):
 * 1. ZIP limits: ≤ 64 entries, ≤ 16 MiB per entry, ≤ 32 MiB in all — declared, and EVERY entry actually inflated
 *    (capped at its declared size + 1 byte), read or not;
 * 2. part caps: `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` ≤ 1 MiB each (shared strings and the
 *    first sheet are bounded by the 16 MiB entry limit);
 * 3. the linear pre-scan (xlsx-scan.ts): the first sheet ≤ 20 000 `<row>` elements (empty ones included), ≤ 64 `<c>`
 *    elements per row and no cell reference beyond column 64 (BL); the shared strings ≤ 200 000 `<si>` items and
 *    ≤ 200 000 rich-text runs;
 * 4. exceljs reads a minimal in-memory workbook (workbook part, one relationship, styles, shared strings, the first
 *    sheet — shared strings before the sheet, so exceljs never buffers it to a temporary file); more than 10 000
 *    non-empty data rows → `tooManyRows` (the header is checked by the caller afterwards).
 *
 * Limits → `tooLarge`; anything else that is not a readable workbook → `unsupported`.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { storedZip, unzip, ZipError, type ZipEntry } from '../../infra/zip.js';
import { firstSheetPath, prescanSharedStrings, prescanSheet, SCAN_LIMITS, ScanError } from './xlsx-scan.js';

const MiB = 1024 * 1024;
export const XLSX_ZIP_LIMITS = { maxEntries: 64, maxEntryBytes: 16 * MiB, maxTotalBytes: 32 * MiB };
export const XLSX_PART_CAPS: Readonly<Record<string, number>> = {
  'xl/workbook.xml': MiB,
  'xl/_rels/workbook.xml.rels': MiB,
  'xl/styles.xml': MiB,
};
export const MAX_DATA_ROWS = 10_000;

/**
 * A cell as it crosses the thread boundary: its text; null — a cell of another type (date, boolean, error); 1 — a text
 * longer than `MAX_CELL_CHARS` (P25: never shipped; the import reports `validation.maxLength`).
 */
export type WireCell = string | null | 1;
/** P25: the result is bounded inside the worker — cells of at most 1 000 characters, 8 MiB of UTF-8 text in all. */
export const MAX_CELL_CHARS = 1000;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
export type XlsxResult =
  | { ok: true; header: WireCell[] | null; rows: { number: number; cells: WireCell[] }[] }
  | { ok: false; kind: 'tooLarge' | 'unsupported' | 'tooManyRows' };

class Stop extends Error {
  constructor(readonly kind: 'tooLarge' | 'unsupported' | 'tooManyRows') {
    super(kind);
  }
}

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const EMPTY_SST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`;

const utf8 = (b: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new Stop('unsupported');
  }
};

/** The shortest decimal text that reads back as `n` (JavaScript's own), written without an exponent. */
export function numberText(n: number): string {
  const s = String(n);
  const e = s.indexOf('e');
  if (e < 0) return s;
  const neg = s.startsWith('-');
  const mantissa = s.slice(neg ? 1 : 0, e);
  const exp = Number(s.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const int = dot < 0 ? mantissa : mantissa.slice(0, dot);
  const digits = dot < 0 ? mantissa : int + mantissa.slice(dot + 1);
  const point = int.length + exp;
  const body =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (neg ? '-' : '') + body;
}

type XlsxValue = ExcelJS.CellValue | { sharedString: number } | undefined;

function cellText(v: XlsxValue): WireCell {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? numberText(v) : null;
  if (typeof v === 'boolean' || v instanceof Date) return null;
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return null;
    if ('formula' in v || 'sharedFormula' in v) {
      const result = (v as { result?: unknown }).result;
      if (result === undefined || result === null) return null;
      return cellText(result as XlsxValue);
    }
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
  }
  return null;
}

/** A sheet stores no empty cells: trailing empty cells are dropped (a narrower row is padded by the import). */
function trimTrailing(cells: WireCell[]): WireCell[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}

/** Steps 1–3: the parts of the first sheet, every limit checked; the minimal workbook for exceljs. */
function minimalWorkbook(bytes: Buffer): Buffer {
  const wanted = (n: string) =>
    n === '[Content_Types].xml' ||
    n in XLSX_PART_CAPS ||
    n === 'xl/sharedStrings.xml' ||
    n.startsWith('xl/worksheets/');
  let entries: ZipEntry[];
  try {
    entries = unzip(bytes, XLSX_ZIP_LIMITS, wanted);
  } catch (err) {
    throw new Stop(err instanceof ZipError && err.kind === 'tooLarge' ? 'tooLarge' : 'unsupported');
  }
  const part = (name: string) => entries.find((e) => e.name === name)?.data;
  for (const e of entries)
    if ((XLSX_PART_CAPS[e.name] ?? Infinity) < e.data.length) throw new Stop('tooLarge');
  const workbook = part('xl/workbook.xml');
  const rels = part('xl/_rels/workbook.xml.rels');
  if (!part('[Content_Types].xml') || !workbook || !rels) throw new Stop('unsupported');
  const sheetPath = firstSheetPath(utf8(workbook), utf8(rels));
  const sheet = sheetPath ? part(sheetPath) : undefined;
  if (!sheet) throw new Stop('unsupported');
  const strings = part('xl/sharedStrings.xml');
  prescanSheet(utf8(sheet));
  if (strings) prescanSharedStrings(utf8(strings));
  const styles = part('xl/styles.xml');
  return storedZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS, 'utf8') },
    ...(styles ? [{ name: 'xl/styles.xml', data: styles }] : []),
    { name: 'xl/sharedStrings.xml', data: strings ?? Buffer.from(EMPTY_SST, 'utf8') },
    { name: SHEET_PATH, data: sheet },
  ]);
}

/** Step 4 and the result (never throws). */
export async function readWorkbook(bytes: Buffer): Promise<XlsxResult> {
  try {
    const minimal = minimalWorkbook(bytes);
    // Fed in 64 KiB chunks: exceljs parses (and holds the events of) one chunk at a time — a whole-buffer chunk would
    // make it materialize every cell of the sheet at once (P24: 5 000 × 64 cells took ~370 MB of heap that way).
    // Each chunk ends right before a `<` byte (P25): exceljs decodes every chunk as UTF-8 on its own, so a chunk must
    // never end inside a multi-byte character — and `<` (0x3C) never occurs inside one.
    const chunks = function* () {
      for (let i = 0; i < minimal.length;) {
        const lt = minimal.indexOf(0x3c, i + 64 * 1024);
        const end = lt < 0 ? minimal.length : lt;
        yield minimal.subarray(i, end);
        i = end;
      }
    };
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(chunks()), {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'cache',
      worksheets: 'emit',
      entries: 'ignore',
    });
    let header: WireCell[] | null = null;
    const rows: { number: number; cells: WireCell[] }[] = [];
    let seen = 0;
    let resultBytes = 0;
    const bounded = (list: WireCell[]): WireCell[] =>
      list.map((c) => {
        if (typeof c !== 'string') return c;
        // Characters are code points (R36); the UTF-16 length bounds the count cheaply.
        if (c.length > 2 * MAX_CELL_CHARS || (c.length > MAX_CELL_CHARS && [...c].length > MAX_CELL_CHARS))
          return 1;
        resultBytes += Buffer.byteLength(c, 'utf8');
        if (resultBytes > MAX_RESULT_BYTES) throw new Stop('tooLarge');
        return c;
      });
    for await (const ws of reader) {
      let first = true;
      for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
        // Belt and braces: the pre-scan already bounds rows and cells.
        if (++seen > SCAN_LIMITS.maxRows) throw new Stop('tooLarge');
        const values = row.values as XlsxValue[];
        if (values.length - 1 > SCAN_LIMITS.maxCellsPerRow) throw new Stop('tooLarge');
        const cells: WireCell[] = [];
        for (let col = 1; col < values.length; col++) cells.push(cellText(values[col]));
        const trimmed = trimTrailing(cells);
        if (first) {
          first = false;
          if (row.number === 1) {
            header = bounded(trimmed);
            continue;
          }
        }
        if (row.number === 1 || trimmed.every((c) => c === '')) continue;
        if (rows.length === MAX_DATA_ROWS) throw new Stop('tooManyRows');
        rows.push({ number: row.number, cells: bounded(trimmed) });
      }
      break;
    }
    return { ok: true, header, rows };
  } catch (err) {
    if (err instanceof Stop) return { ok: false, kind: err.kind };
    if (err instanceof ScanError)
      return { ok: false, kind: err.kind === 'tooLarge' ? 'tooLarge' : 'unsupported' };
    return { ok: false, kind: 'unsupported' };
  }
}

/** The result crosses threads as ONE transferable ArrayBuffer of JSON (P25), never as a cloned object graph. */
export function encodeResult(r: XlsxResult): ArrayBuffer {
  const b = Buffer.from(JSON.stringify(r), 'utf8');
  const ab = new ArrayBuffer(b.length);
  new Uint8Array(ab).set(b);
  return ab;
}

export function decodeResult(ab: ArrayBuffer): XlsxResult {
  return JSON.parse(Buffer.from(ab).toString('utf8')) as XlsxResult;
}
