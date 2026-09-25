/**
 * Minimal XLSX (OOXML SpreadsheetML) reading and writing on top of fflate — CSP-safe (no eval), small:
 * - reading: the first sheet of the workbook, cells as text (strings as is, numbers in their shortest decimal
 *   writing, other types — INVALID), rows with their sheet numbers;
 * - writing: sheets of typed cells (text, integer `0`, mass `0.000`, percent/hours `0.00`), a bold header row.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

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

/** The shortest decimal text that reads back as `n`, without an exponent. */
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

/** Whether the ZIP is an OOXML workbook ([Content_Types].xml and xl/workbook.xml). Throws on a broken ZIP. */
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

/** Rows of the first worksheet: header (row 1) and data rows with their numbers; trailing empty cells dropped. */
export function readXlsx(b: Uint8Array): { header: Cell[] | null; rows: { number: number; cells: Cell[] }[] } {
  const files = unzipSync(b);
  const text = (name: string): string | null => (files[name] ? strFromU8(files[name]!) : null);
  const workbook = text('xl/workbook.xml') ?? '';
  const firstSheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
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
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
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
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    let end = cells.length;
    while (end > 0 && cells[end - 1] === '') end--;
    out.push({ number, cells: cells.slice(0, end) });
  }
  const headerRow = out.find((r) => r.number === 1);
  return { header: headerRow ? headerRow.cells : null, rows: out.filter((r) => r.number !== 1) };
}

// ── writing ──

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
