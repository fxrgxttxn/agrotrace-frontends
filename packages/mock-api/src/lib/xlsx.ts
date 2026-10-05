import { strFromU8, strToU8, Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate';

export const INVALID = Symbol('invalid cell');
export type Cell = string | typeof INVALID;

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const encodeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

export const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export function isWorkbook(b: Uint8Array): boolean {
  let found = 0;
  unzipSync(b, {
    filter: (f) => {
      if (f.name === '[Content_Types].xml' || f.name === 'xl/workbook.xml') found++;
      return false;
    },
  });
  return found === 2;
}

const colIndex = (ref: string): number => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export class WorkbookTooLarge extends Error {}
const MIB = 1024 * 1024;

export const XLSX_MAX_ENTRIES = 64;
export const XLSX_MAX_ENTRY_BYTES = 16 * MIB;
export const XLSX_MAX_TOTAL_BYTES = 32 * MIB;

export function inflateEntries(b: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let entries = 0;
  let total = 0;
  let failure: unknown = null;
  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > XLSX_MAX_ENTRIES) throw new WorkbookTooLarge();
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = err;
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > XLSX_MAX_ENTRY_BYTES || total > XLSX_MAX_TOTAL_BYTES) {
        failure = new WorkbookTooLarge();
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        files[file.name] = out;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const SLICE = 64 * 1024;
  for (let at = 0; at < b.length && !failure; at += SLICE) unzip.push(b.subarray(at, at + SLICE), at + SLICE >= b.length);
  if (failure) throw failure;
  return files;
}

export function readXlsx(b: Uint8Array, sheetIndex = 0): { header: Cell[] | null; rows: { number: number; cells: Cell[] }[] } {
  const files = inflateEntries(b);
  const text = (name: string): string | null => (files[name] ? strFromU8(files[name]!) : null);
  const workbook = text('xl/workbook.xml') ?? '';
  const firstSheetRid = [...workbook.matchAll(/<sheet\b[^>]*\br:id="([^"]+)"/g)][sheetIndex]?.[1];
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  let target = 'worksheets/sheet1.xml';
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    if (firstSheetRid && new RegExp(`\\bId="${firstSheetRid}"`).test(attrs)) target = /\bTarget="([^"]+)"/.exec(attrs)?.[1] ?? target;
  }
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const shared: string[] = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst)
    for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g))
      shared.push([...si[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(''));
  const sheet = text(sheetPath);
  if (sheet === null) throw new Error('no worksheet');
  const out: { number: number; cells: Cell[] }[] = [];
  let rowCount = 0;
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    rowCount += 1;
    if (rowCount > 20_000) throw new WorkbookTooLarge();
    const number = Number(/\br="(\d+)"/.exec(row[1] ?? row[3] ?? '')?.[1] ?? out.length + 1);
    const cells: Cell[] = [];
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const inner = c[2] ?? '';
      const idx = colIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '');
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: Cell;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join('');
      else if (type === 'str') value = v === undefined ? INVALID : decodeXml(v);
      else if (type === 'n') value = v === undefined ? '' : Number.isFinite(Number(v)) ? numberText(Number(v)) : INVALID;
      else value = INVALID;
      if (idx >= 64) throw new WorkbookTooLarge();
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
      if (cells.length > 64) throw new WorkbookTooLarge();
    }
    let end = cells.length;
    while (end > 0 && cells[end - 1] === '') end--;
    out.push({ number, cells: cells.slice(0, end) });
  }
  const headerRow = out.find((r) => r.number === 1);
  return { header: headerRow ? headerRow.cells : null, rows: out.filter((r) => r.number !== 1) };
}

export type XCell = { t: 'text'; v: string | null } | { t: 'int' | 'mass' | 'dec2'; v: number | string | null };
export interface XSheet {
  name: string;
  header: string[];
  rows: XCell[][];
}

const STYLE = { header: 1, int: 2, mass: 3, dec2: 4 } as const;

const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, xml: string) => (files[name] = strToU8(xml));
  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
  );
  put(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  put(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${encodeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  put(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  put(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  );
  sheets.forEach((s, i) => {
    const rows: string[] = [];
    const cell = (ref: string, c: XCell, header = false): string => {
      if (c.v === null || c.v === '') return '';
      if (c.t === 'text') return `<c r="${ref}" t="inlineStr"${header ? ` s="${STYLE.header}"` : ''}><is><t xml:space="preserve">${encodeXml(String(c.v))}</t></is></c>`;
      return `<c r="${ref}" s="${STYLE[c.t]}"><v>${Number(c.v)}</v></c>`;
    };
    rows.push(`<row r="1">${s.header.map((h, j) => cell(`${colName(j)}1`, { t: 'text', v: h }, true)).join('')}</row>`);
    s.rows.forEach((r, k) => rows.push(`<row r="${k + 2}">${r.map((c, j) => cell(`${colName(j)}${k + 2}`, c)).join('')}</row>`));
    put(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
    );
  });
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
