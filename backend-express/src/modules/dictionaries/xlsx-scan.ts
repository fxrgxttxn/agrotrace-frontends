/**
 * A linear XML tag scanner for the XLSX pre-scan (P24): no regular expression, no backtracking — every character of
 * the input is looked at a bounded number of times (`indexOf` jumps plus one pass over each tag), so an adversarial
 * document costs time proportional to its size and a limit aborts the scan at once. It is not a validating parser:
 * it reports start/end tags (local names, with the attributes a caller asks for), skips comments, processing
 * instructions and CDATA, and refuses DOCTYPE/entity declarations and malformed tags.
 */

export class ScanError extends Error {
  constructor(readonly kind: 'malformed' | 'tooLarge') {
    super(`xlsx scan: ${kind}`);
  }
}

export interface Tag {
  end: boolean;
  selfClosing: boolean;
  /** The local name (after the last `:`). */
  name: string;
  /** The qualified name carries a prefix (`x:row`). */
  prefixed: boolean;
  /** The default namespace this tag declares (`xmlns="…"`), if it declares one. */
  defaultNs?: string;
  /** Requested attributes by local name (a prefixed `r:id` is `id`), entity-decoded; empty when not requested. */
  attrs: ReadonlyMap<string, string>;
}

const NO_ATTRS: ReadonlyMap<string, string> = new Map();
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const local = (name: string) => {
  const i = name.lastIndexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

function decode(v: string): string {
  if (v.indexOf('&') < 0) return v;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = v.indexOf('&', i);
    if (amp < 0) return out + v.slice(i);
    out += v.slice(i, amp);
    const semi = v.indexOf(';', amp);
    if (semi < 0 || semi - amp > 10) throw new ScanError('malformed');
    const ent = v.slice(amp + 1, semi);
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (ent in named) out += named[ent];
    else if (ent.startsWith('#x')) out += String.fromCodePoint(parseInt(ent.slice(2), 16) || 0xfffd);
    else if (ent.startsWith('#')) out += String.fromCodePoint(parseInt(ent.slice(1), 10) || 0xfffd);
    else throw new ScanError('malformed');
    i = semi + 1;
  }
}

/**
 * Calls `onTag` for every tag of `text`, in order; `wantAttrs(name)` says for which local tag names the attributes
 * are collected. `onTag` returning `false` stops the scan. Throws ScanError('malformed') for what is not XML.
 */
export function scanXml(
  text: string,
  wantAttrs: (name: string) => boolean,
  onTag: (t: Tag) => boolean | void,
): void {
  const n = text.length;
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return;
    const c = text.charCodeAt(lt + 1);
    if (c === 0x3f /* ? */) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new ScanError('malformed');
      i = end + 2;
      continue;
    }
    if (c === 0x21 /* ! */) {
      let end: number;
      if (text.startsWith('<!--', lt)) end = text.indexOf('-->', lt + 4) + 3;
      else if (text.startsWith('<![CDATA[', lt)) end = text.indexOf(']]>', lt + 9) + 3;
      else throw new ScanError('malformed'); // DOCTYPE, entities
      if (end < 3) throw new ScanError('malformed');
      i = end;
      continue;
    }
    const isEnd = c === 0x2f; /* / */
    let p = lt + (isEnd ? 2 : 1);
    const nameStart = p;
    while (p < n) {
      const ch = text.charCodeAt(p);
      if (isSpace(ch) || ch === 0x2f || ch === 0x3e /* > */ || ch === 0x3c /* < */) break;
      p++;
    }
    if (p === nameStart || p >= n) throw new ScanError('malformed');
    const qname = text.slice(nameStart, p);
    const name = local(qname);
    let attrs: Map<string, string> | null = null;
    const tag: Tag = { end: isEnd, selfClosing: false, name, prefixed: name !== qname, attrs: NO_ATTRS };
    if (isEnd) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 0x3e) throw new ScanError('malformed');
      i = p + 1;
    } else {
      const collect = wantAttrs(name);
      for (;;) {
        while (p < n && isSpace(text.charCodeAt(p))) p++;
        if (p >= n) throw new ScanError('malformed');
        const ch = text.charCodeAt(p);
        if (ch === 0x3e) {
          p++;
          break;
        }
        if (ch === 0x2f) {
          if (text.charCodeAt(p + 1) !== 0x3e) throw new ScanError('malformed');
          tag.selfClosing = true;
          p += 2;
          break;
        }
        const attrStart = p;
        while (p < n) {
          const a = text.charCodeAt(p);
          if (isSpace(a) || a === 0x3d /* = */ || a === 0x3e || a === 0x2f || a === 0x3c) break;
          p++;
        }
        if (p === attrStart) throw new ScanError('malformed');
        const attrName = text.slice(attrStart, p);
        while (p < n && isSpace(text.charCodeAt(p))) p++;
        if (text.charCodeAt(p) !== 0x3d) throw new ScanError('malformed');
        p++;
        while (p < n && isSpace(text.charCodeAt(p))) p++;
        const q = text.charCodeAt(p);
        if (q !== 0x22 && q !== 0x27) throw new ScanError('malformed');
        const close = text.indexOf(q === 0x22 ? '"' : "'", p + 1);
        if (close < 0) throw new ScanError('malformed');
        if (attrName === 'xmlns') tag.defaultNs = decode(text.slice(p + 1, close));
        if (collect) {
          attrs ??= new Map();
          attrs.set(local(attrName), decode(text.slice(p + 1, close)));
          tag.attrs = attrs;
        }
        p = close + 1;
      }
      i = p;
    }
    if (onTag(tag) === false) return;
  }
}

/** The archive path of the first sheet in workbook order (`xl/workbook.xml` → its relationship target). */
/** The Transitional SpreadsheetML main namespace (P26); the Strict one (purl.oclc.org) or none is refused. */
export const SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/**
 * A namespace guard for one part: its root element must be `root`, unprefixed, declaring the SpreadsheetML default
 * namespace, and no element inside may declare another default namespace (`xmlns="urn:…"`). Returns the check to run
 * on every tag.
 */
function namespaceGuard(root: string): (t: Tag) => void {
  let first = true;
  return (t) => {
    if (t.end) return;
    if (first) {
      first = false;
      if (t.name !== root || t.prefixed || t.defaultNs !== SPREADSHEETML) throw new ScanError('malformed');
      return;
    }
    if (t.defaultNs !== undefined && t.defaultNs !== SPREADSHEETML) throw new ScanError('malformed');
  };
}

/**
 * The archive path of the first sheet in workbook order (`xl/workbook.xml` → its relationship target). The workbook
 * part itself must be SpreadsheetML (P26): root `workbook` in the Transitional main namespace, no foreign default
 * namespace inside.
 */
export function firstSheetPath(workbook: string, rels: string): string | null {
  let rid: string | undefined;
  const ns = namespaceGuard('workbook');
  scanXml(
    workbook,
    (name) => name === 'sheet',
    (t) => {
      ns(t);
      if (t.end || t.name !== 'sheet' || rid !== undefined) return;
      rid = t.attrs.get('id');
    },
  );
  if (!rid) return null;
  let target: string | undefined;
  scanXml(
    rels,
    (name) => name === 'Relationship',
    (t) => {
      if (t.end || t.name !== 'Relationship' || t.attrs.get('Id') !== rid) return;
      target = t.attrs.get('Target');
      return false;
    },
  );
  if (!target) return null;
  return target.startsWith('/')
    ? target.slice(1)
    : `xl/${target.startsWith('./') ? target.slice(2) : target}`;
}

export const SCAN_LIMITS = { maxRows: 20_000, maxCellsPerRow: 64, maxStrings: 200_000, maxRuns: 200_000 };
/** The last row of a sheet (Excel's grid): a row number above it is no row. */
export const MAX_ROW_NUMBER = 1_048_576;

/** A row reference: a positive integer without sign, leading zero or fraction, ≤ MAX_ROW_NUMBER; else null. */
function rowNumber(s: string): number | null {
  if (s.length === 0 || s.length > 7) return null;
  let n = 0;
  for (let k = 0; k < s.length; k++) {
    const d = s.charCodeAt(k) - 0x30;
    if (d < 0 || d > 9 || (k === 0 && d === 0)) return null;
    n = n * 10 + d;
  }
  return n <= MAX_ROW_NUMBER ? n : null;
}

/**
 * A cell reference: upper-case column letters (1–3) then its row number, no `$`, no space — `BL12` → {col: 64, row: 12};
 * else null.
 */
function cellRef(s: string): { col: number; row: number } | null {
  let col = 0;
  let k = 0;
  for (; k < s.length && k < 4; k++) {
    const ch = s.charCodeAt(k);
    if (ch < 0x41 || ch > 0x5a) break;
    col = col * 26 + (ch - 0x40);
  }
  if (k === 0 || k > 3) return null;
  const row = rowNumber(s.slice(k));
  return row === null ? null : { col, row };
}

/** SpreadsheetML elements exceljs reads by their unprefixed names (a prefixed one would be silently skipped by it). */
const SHEET_ELEMENTS = new Set(['worksheet', 'sheetData', 'row', 'c', 'v', 'f', 'is', 't', 'r']);
const SST_ELEMENTS = new Set(['sst', 'si', 't', 'r', 'rPh']);

/**
 * The first sheet (P24–P26), in document order; the first violation wins, and on one element a malformed reference
 * wins over a limit:
 * - SpreadsheetML: root `worksheet` in the Transitional main namespace, no foreign default namespace inside, the
 *   SpreadsheetML elements unprefixed → otherwise malformed (415);
 * - every `<row>` has `r` = a positive integer (no sign, no leading zero, no fraction, ≤ 1 048 576), strictly
 *   increasing through the part; every `<c>` is inside a `<row>` and has `r` = an upper-case A1 reference without `$`
 *   whose row is that row's number, columns strictly increasing within the row → otherwise malformed (415);
 * - ≤ `maxRows` `<row>` elements anywhere in the part (empty ones included), ≤ `maxCellsPerRow` `<c>` elements in a
 *   row and no cell beyond that column (`BL`) → otherwise too large, raised as soon as it is exceeded.
 */
export function prescanSheet(text: string, limits = SCAN_LIMITS): void {
  let rows = 0;
  let cells = 0;
  let inRow = false;
  let lastRow = 0;
  let lastCol = 0;
  const ns = namespaceGuard('worksheet');
  scanXml(
    text,
    (name) => name === 'c' || name === 'row',
    (t) => {
      ns(t);
      if (t.prefixed && SHEET_ELEMENTS.has(t.name)) throw new ScanError('malformed');
      if (t.name === 'row') {
        if (t.end) {
          inRow = false;
          return;
        }
        const r = rowNumber(t.attrs.get('r') ?? '');
        if (r === null || r <= lastRow) throw new ScanError('malformed');
        if (++rows > limits.maxRows) throw new ScanError('tooLarge');
        lastRow = r;
        lastCol = 0;
        cells = 0;
        inRow = !t.selfClosing;
        return;
      }
      if (t.name === 'c' && !t.end) {
        const ref = cellRef(t.attrs.get('r') ?? '');
        if (!inRow || ref === null || ref.row !== lastRow || ref.col <= lastCol)
          throw new ScanError('malformed');
        lastCol = ref.col;
        if (++cells > limits.maxCellsPerRow || ref.col > limits.maxCellsPerRow)
          throw new ScanError('tooLarge');
      }
    },
  );
}

/**
 * The shared strings: root `sst` in the SpreadsheetML namespace, unprefixed; ≤ `maxStrings` `<si>` items and
 * ≤ `maxRuns` rich-text runs (`<r>`) in all.
 */
export function prescanSharedStrings(text: string, limits = SCAN_LIMITS): void {
  let strings = 0;
  let runs = 0;
  const ns = namespaceGuard('sst');
  scanXml(
    text,
    () => false,
    (t) => {
      ns(t);
      if (t.prefixed && SST_ELEMENTS.has(t.name)) throw new ScanError('malformed');
      if (t.end) return;
      if (t.name === 'si' && ++strings > limits.maxStrings) throw new ScanError('tooLarge');
      if (t.name === 'r' && ++runs > limits.maxRuns) throw new ScanError('tooLarge');
    },
  );
}
