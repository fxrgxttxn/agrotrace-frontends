/**
 * Reading an import file (importDictionary, R58): the type is decided by the content, never by the name or the part's
 * Content-Type —
 *
 * - a ZIP (`PK\x03\x04`) is an XLSX workbook. The API thread only checks the ZIP directory (≤ 64 entries, declared
 *   sizes ≤ 16 MiB per entry and ≤ 32 MiB in all, the part caps of the workbook part, its relationships and styles
 *   ≤ 1 MiB); everything else — inflating and checking every entry, the linear pre-scan, exceljs — runs in a worker
 *   thread (xlsx-read.ts, P24) behind a bounded two-lane queue (infra/worker-queue.ts: 1 running + 8 waiting per
 *   lane, a 10 s deadline from enqueue after which the worker is terminated, a 256 MB worker heap). Any limit, a full
 *   queue, the deadline or a worker killed by its heap limit → 415 `{allowed, reason: "workbook-too-large"}`; a ZIP
 *   that is not a readable workbook → 415 `{allowed}`;
 * - otherwise a byte NUL → 415; invalid UTF-8 or an unclosed quote → 400 `errors.file: [validation.import.format]`;
 *   the rest is CSV: UTF-8 (a leading BOM is skipped), `;` separators, RFC 4180 quotes, CRLF or LF record ends.
 *
 * The result is the header and the data rows with their numbers (CSV: the record number; XLSX: the sheet row number;
 * the header is row 1, skipped empty rows are counted). A cell is a string, or INVALID for an XLSX cell of another
 * type (date, boolean, error) — the import reports it as `validation.pattern`. More than 10 000 non-empty data rows →
 * 400 `validation.import.tooManyRows` (reading stops there; before the header check).
 */
import { AppProblem, validationProblem } from '../../http/problem.js';
import { workerEngine, WorkerQueue, type Engine } from '../../infra/worker-queue.js';
import { ZipError, zipDirectory } from '../../infra/zip.js';
import { MAX_DATA_ROWS, XLSX_PART_CAPS, XLSX_ZIP_LIMITS, type XlsxResult } from './xlsx-read.js';

export { MAX_DATA_ROWS };
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

export const IMPORT_TYPES = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

const unsupported = () =>
  new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: IMPORT_TYPES } });
const tooLarge = () =>
  new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', {
    params: { allowed: IMPORT_TYPES, reason: 'workbook-too-large' },
  });
const badFormat = () => validationProblem({ file: ['validation.import.format'] });
const tooManyRows = () => validationProblem({ file: ['validation.import.tooManyRows'] });

export const isEmptyRow = (cells: Cell[]): boolean => cells.every((c) => c === '');

export type XlsxQueue = WorkerQueue<Buffer, XlsxResult>;

export async function readSheet(
  bytes: Buffer,
  opts: { signal?: AbortSignal; queue?: XlsxQueue } = {},
): Promise<Sheet> {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return readXlsx(bytes, opts);
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

export const XLSX_DEADLINE_MS = 10_000;
export const XLSX_QUEUE_WAITING = 8;
export const XLSX_SMALL_LANE_BYTES = 64 * 1024;
export const XLSX_WORKER_HEAP_MB = 256;

export function xlsxWorkerEngine(): Engine<Buffer, XlsxResult> {
  return workerEngine(
    { js: new URL('./xlsx-worker.js', import.meta.url), ts: new URL('./xlsx-worker.ts', import.meta.url) },
    XLSX_WORKER_HEAP_MB,
  );
}

const lanes: { small: XlsxQueue | null; large: XlsxQueue | null } = { small: null, large: null };
const laneOf = (size: number): XlsxQueue => {
  const lane = size <= XLSX_SMALL_LANE_BYTES ? 'small' : 'large';
  return (lanes[lane] ??= new WorkerQueue(xlsxWorkerEngine, {
    maxWaiting: XLSX_QUEUE_WAITING,
    deadlineMs: XLSX_DEADLINE_MS,
  }));
};

/** The only work on the API thread: the ZIP directory (declared sizes) and the part caps. */
function checkDirectory(bytes: Buffer): void {
  let entries;
  try {
    entries = zipDirectory(bytes, XLSX_ZIP_LIMITS);
  } catch (err) {
    throw err instanceof ZipError && err.kind === 'tooLarge' ? tooLarge() : unsupported();
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw unsupported();
  for (const e of entries) if ((XLSX_PART_CAPS[e.name] ?? Infinity) < e.size) throw tooLarge();
}

async function readXlsx(bytes: Buffer, opts: { signal?: AbortSignal; queue?: XlsxQueue }): Promise<Sheet> {
  checkDirectory(bytes);
  const o = await (opts.queue ?? laneOf(bytes.length)).run(bytes, opts.signal);
  if (!o.ok) throw o.reason === 'too-complex' ? tooLarge() : unsupported(); // aborted: nobody reads the answer
  const r = o.value;
  if (!r.ok)
    throw r.kind === 'tooLarge' ? tooLarge() : r.kind === 'tooManyRows' ? tooManyRows() : unsupported();
  const cells = (list: (string | null)[]): Cell[] => list.map((c) => (c === null ? INVALID : c));
  return {
    header: r.header ? cells(r.header) : null,
    rows: r.rows.map((row) => ({ number: row.number, cells: cells(row.cells) })),
    padShort: true,
  };
}
