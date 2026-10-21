/**
 * A linear, namespace-aware XML scanner for the XLSX pre-scan (P24–P28): no regular expression, no backtracking —
 * every character of the input is looked at a bounded number of times (`indexOf` jumps plus one pass over each tag),
 * so an adversarial document costs time proportional to its size and a limit aborts the scan at once.
 *
 * It is not a validating parser, but it refuses what is not namespace-well-formed XML 1.0 (P27, P28): a character
 * outside XML's Char production (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF), an encoding other
 * than UTF-8 declared, DOCTYPE/entity declarations, `--` inside a comment, a malformed tag or QName (an empty prefix
 * or local part, more than one `:`), `<` in an attribute value, a duplicate attribute (by name or by expanded name), an
 * undefined entity or an illegal character reference, an unbound prefix, a reserved binding misused (`xml`, `xmlns`),
 * an end tag that does not match, an unclosed element, a second root element, non-whitespace text or CDATA outside the
 * root, nesting deeper than 256. It reports start/end tags with their local name and resolved namespace.
 */

export class ScanError extends Error {
  constructor(readonly kind: 'malformed' | 'tooLarge') {
    super(`xlsx scan: ${kind}`);
  }
}

export interface Tag {
  end: boolean;
  selfClosing: boolean;
  /** The local name (after the `:`). */
  name: string;
  /** The qualified name carries a prefix (`x:row`). */
  prefixed: boolean;
  /** The element's namespace, resolved through the prefix bindings in scope ('' — none). */
  ns: string;
  /** The default namespace this tag declares (`xmlns="…"`), if it declares one. */
  defaultNs?: string;
  /**
   * Requested attributes, entity-decoded: an unprefixed attribute by its name (`r`), a prefixed one as
   * `{namespace}local` (`{…/relationships}id`); empty when not requested.
   */
  attrs: ReadonlyMap<string, string>;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MAX_DEPTH = 256;
const NO_ATTRS: ReadonlyMap<string, string> = new Map();
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const malformed = (): never => {
  throw new ScanError('malformed');
};

/** A QName: `local` or `prefix:local`, both parts non-empty, at most one `:` (P28). */
function splitName(q: string): [string, string] {
  const i = q.indexOf(':');
  if (i < 0) return q.length ? ['', q] : malformed();
  if (i === 0 || i === q.length - 1 || q.indexOf(':', i + 1) >= 0) return malformed();
  return [q.slice(0, i), q.slice(i + 1)];
}

/** A code point XML 1.0 allows (Char production). */
const legalChar = (c: number) =>
  c === 0x9 ||
  c === 0xa ||
  c === 0xd ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);

/**
 * One pass over the text: every UTF-16 unit is part of a legal Char. The text comes from a fatal UTF-8 decode, so
 * surrogates are always paired; the remaining exclusions are the C0 controls (but TAB, LF, CR) and U+FFFE/U+FFFF.
 */
function checkChars(text: string): void {
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if ((c < 0x20 && c !== 0x9 && c !== 0xa && c !== 0xd) || c === 0xfffe || c === 0xffff) malformed();
  }
}

/**
 * The text of an entity or character reference (`amp`, `#58`, `#x0000003A`); malformed when undefined or illegal.
 * A numeric reference may have any number of digits (leading zeros) as long as its value is a legal Char.
 */
function entityText(ent: string): string {
  const named = NAMED[ent];
  if (named !== undefined) return named;
  if (ent.length < 2 || ent.charCodeAt(0) !== 0x23 /* # */) return malformed();
  const hex = ent.charCodeAt(1) === 0x78; /* x */
  const digits = ent.slice(hex ? 2 : 1);
  if (digits.length === 0) return malformed();
  let n = 0;
  for (let k = 0; k < digits.length; k++) {
    const d = digits.charCodeAt(k);
    const v =
      d >= 0x30 && d <= 0x39
        ? d - 0x30
        : hex && (d | 0x20) >= 0x61 && (d | 0x20) <= 0x66
          ? (d | 0x20) - 0x57
          : -1;
    if (v < 0) return malformed();
    n = n * (hex ? 16 : 10) + v;
    if (n > 0x10ffff) return malformed();
  }
  if (!legalChar(n)) return malformed();
  return String.fromCodePoint(n);
}

/** Entity-decodes `v` (an attribute value), validating every reference. */
function decode(v: string): string {
  if (v.indexOf('&') < 0) return v;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = v.indexOf('&', i);
    if (amp < 0) return out + v.slice(i);
    const semi = v.indexOf(';', amp);
    if (semi < 0) return malformed();
    out += v.slice(i, amp) + entityText(v.slice(amp + 1, semi));
    i = semi + 1;
  }
}

/**
 * Validates the references in the character data of `text`, segment by segment (`check(from, to)` in increasing
 * order). The next `&` is searched once and remembered, so the whole document costs one pass — searching afresh from
 * every segment would rescan the rest of a document without `&` for each of its segments.
 */
function textChecker(text: string): (from: number, to: number) => void {
  let next = -2; // the next `&` at or after the last search start; -1 — none left
  return (from, to) => {
    for (;;) {
      if (next !== -1 && next < from) next = text.indexOf('&', from);
      if (next < 0 || next >= to) return;
      const semi = text.indexOf(';', next);
      if (semi < 0 || semi > to) malformed();
      entityText(text.slice(next + 1, semi));
      from = semi + 1;
    }
  };
}

/**
 * Prefix bindings in scope, without copying (P28): one map of the current bindings; an element that declares prefixes
 * records what it replaced and restores it when it closes.
 */
class Bindings {
  // Keys are never deleted — an unbound prefix maps to undefined: deleting and re-adding keys of a large Map makes V8
  // rehash it, which turned many small declaring elements under many root bindings quadratic.
  private readonly current = new Map<string, string | undefined>([['xml', XML_NS]]);

  get(prefix: string): string | undefined {
    return this.current.get(prefix);
  }

  /** Applies `decls`; returns the undo record. */
  push(decls: Map<string, string>): [string, string | undefined][] {
    const undo: [string, string | undefined][] = [];
    for (const [p, uri] of decls) {
      undo.push([p, this.current.get(p)]);
      this.current.set(p, p === '' && uri === '' ? undefined : uri);
    }
    return undo;
  }

  pop(undo: [string, string | undefined][]): void {
    for (let k = undo.length - 1; k >= 0; k--) {
      const [p, prev] = undo[k]!;
      this.current.set(p, prev);
    }
  }
}

/**
 * Calls `onTag` for every tag of `text`, in order; `wantAttrs(localName)` says for which tags the attributes are
 * collected. Throws ScanError('malformed') for what is not namespace-well-formed XML.
 */
export function scanXml(text: string, wantAttrs: (name: string) => boolean, onTag: (t: Tag) => void): void {
  checkChars(text);
  const n = text.length;
  const stack: { qname: string; undo: [string, string | undefined][] | null }[] = [];
  const bindings = new Bindings();
  const checkText = textChecker(text);
  let rootSeen = false;
  let rootDone = false;
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    const segEnd = lt < 0 ? n : lt;
    if (stack.length === 0) {
      // Outside the root only whitespace (between the prolog's markup and after the root).
      for (let k = i; k < segEnd; k++) if (!isSpace(text.charCodeAt(k))) malformed();
    } else checkText(i, segEnd);
    if (lt < 0) break;
    const c = text.charCodeAt(lt + 1);
    if (c === 0x3f /* ? */) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) malformed();
      if (text.startsWith('<?xml', lt) && isSpace(text.charCodeAt(lt + 5))) {
        // The XML declaration: the encoding label, if any, is exactly UTF-8 (any case) — P27, P28.
        const decl = text.slice(lt, end);
        const k = decl.indexOf('encoding');
        if (k >= 0) {
          let q = decl.indexOf('"', k);
          const q2 = decl.indexOf("'", k);
          if (q < 0 || (q2 >= 0 && q2 < q)) q = q2;
          const close = q < 0 ? -1 : decl.indexOf(decl[q]!, q + 1);
          if (close < 0 || decl.slice(q + 1, close).toLowerCase() !== 'utf-8') malformed();
        }
      }
      i = end + 2;
      continue;
    }
    if (c === 0x21 /* ! */) {
      let end: number;
      if (text.startsWith('<!--', lt)) {
        const close = text.indexOf('-->', lt + 4);
        if (close < 0) malformed();
        // No `--` inside a comment, and it may not end in `-` (`--->`).
        const dd = text.indexOf('--', lt + 4);
        if (dd < close || (close > lt + 4 && text.charCodeAt(close - 1) === 0x2d)) malformed();
        end = close + 3;
      } else if (text.startsWith('<![CDATA[', lt) && stack.length > 0) {
        const close = text.indexOf(']]>', lt + 9);
        if (close < 0) malformed();
        end = close + 3;
      } else return malformed(); // DOCTYPE, entities, CDATA outside the root
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
    if (p === nameStart || p >= n) malformed();
    const qname = text.slice(nameStart, p);
    const [prefix, name] = splitName(qname);
    if (prefix === 'xmlns') malformed(); // a reserved prefix, never an element's

    if (isEnd) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 0x3e) malformed();
      const top = stack.pop();
      if (!top || top.qname !== qname) return malformed();
      const ns = prefix ? bindings.get(prefix)! : (bindings.get('') ?? '');
      if (top.undo) bindings.pop(top.undo);
      if (stack.length === 0) rootDone = true;
      i = p + 1;
      onTag({ end: true, selfClosing: false, name, prefixed: prefix !== '', ns, attrs: NO_ATTRS });
      continue;
    }

    if (rootDone) malformed(); // a second root element
    const collect = wantAttrs(name);
    const seen = new Set<string>();
    const prefixedAttrs: [string, string, string][] = []; // [prefix, local, value]
    let plain: [string, string][] | null = null;
    let decls: Map<string, string> | null = null;
    let defaultNs: string | undefined;
    let selfClosing = false;
    for (;;) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (p >= n) malformed();
      const ch = text.charCodeAt(p);
      if (ch === 0x3e) {
        p++;
        break;
      }
      if (ch === 0x2f) {
        if (text.charCodeAt(p + 1) !== 0x3e) malformed();
        selfClosing = true;
        p += 2;
        break;
      }
      const attrStart = p;
      while (p < n) {
        const a = text.charCodeAt(p);
        if (isSpace(a) || a === 0x3d /* = */ || a === 0x3e || a === 0x2f || a === 0x3c) break;
        p++;
      }
      if (p === attrStart) malformed();
      const attrName = text.slice(attrStart, p);
      if (seen.has(attrName)) malformed();
      seen.add(attrName);
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 0x3d) malformed();
      p++;
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      const q = text.charCodeAt(p);
      if (q !== 0x22 && q !== 0x27) malformed();
      const close = text.indexOf(q === 0x22 ? '"' : "'", p + 1);
      if (close < 0) malformed();
      const rawValue = text.slice(p + 1, close);
      if (rawValue.indexOf('<') >= 0) malformed();
      const value = decode(rawValue);
      p = close + 1;
      const [ap, al] = splitName(attrName);
      if (ap === '' && al === 'xmlns') {
        if (value === XML_NS || value === XMLNS_NS) malformed(); // reserved namespaces are never a default
        defaultNs = value;
        (decls ??= new Map()).set('', value);
      } else if (ap === 'xmlns') {
        // Reserved bindings (P28): `xml` only to its own namespace, `xmlns` never; no other prefix to either.
        if (al === 'xmlns' || value === '' || value === XMLNS_NS) malformed();
        if ((al === 'xml') !== (value === XML_NS)) malformed();
        if (al !== 'xml') (decls ??= new Map()).set(al, value);
      } else if (ap) prefixedAttrs.push([ap, al, value]);
      else if (collect) (plain ??= []).push([al, value]);
    }

    const undo = decls ? bindings.push(decls) : null;
    let ns: string;
    if (prefix) {
      const bound = bindings.get(prefix);
      if (bound === undefined) malformed(); // unbound prefix
      ns = bound!;
    } else ns = bindings.get('') ?? '';
    let attrs: Map<string, string> | null = null;
    if (plain) for (const [k, v] of plain) (attrs ??= new Map()).set(k, v);
    if (prefixedAttrs.length) {
      const expanded = new Set<string>();
      for (const [ap, al, value] of prefixedAttrs) {
        const uri = bindings.get(ap);
        if (uri === undefined) malformed(); // unbound attribute prefix
        const key = `{${uri}}${al}`;
        if (expanded.has(key)) malformed(); // the same expanded name twice (p:a, q:a with one namespace)
        expanded.add(key);
        if (collect) (attrs ??= new Map()).set(key, value);
      }
    }

    rootSeen = true;
    if (selfClosing) {
      if (undo) bindings.pop(undo);
      if (stack.length === 0) rootDone = true;
    } else {
      stack.push({ qname, undo });
      if (stack.length > MAX_DEPTH) malformed();
    }
    i = p;
    onTag({
      end: false,
      selfClosing,
      name,
      prefixed: prefix !== '',
      ns,
      defaultNs,
      attrs: attrs ?? NO_ATTRS,
    });
  }
  if (!rootSeen || stack.length > 0) malformed(); // no root, or an unclosed element
}

/** The Transitional SpreadsheetML main namespace (P26); the Strict one or none is refused. */
export const SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORKSHEET_TYPE = `${R_NS}/worksheet`;

/**
 * The SpreadsheetML rules of one part (P26, P27), run on every tag; returns whether the tag is a SpreadsheetML element
 * the caller should look at (elements of other namespaces — `x14:`, `xm:`, `mc:`, … — are ignored):
 * - the root is `root`, unprefixed, declaring the Transitional main namespace as its default;
 * - no element declares another default namespace;
 * - no element of the SpreadsheetML main (or Strict) namespace carries a prefix.
 */
function spreadsheetGuard(root: string): (t: Tag) => boolean {
  let first = true;
  return (t) => {
    if (!t.end && first) {
      first = false;
      if (t.name !== root || t.prefixed || t.defaultNs !== SPREADSHEETML) throw new ScanError('malformed');
      return true;
    }
    if (!t.end && t.defaultNs !== undefined && t.defaultNs !== SPREADSHEETML)
      throw new ScanError('malformed');
    if (t.ns === SPREADSHEETML || t.ns === STRICT_SPREADSHEETML) {
      if (t.prefixed) throw new ScanError('malformed');
      return true;
    }
    return false;
  };
}

/** Resolves a relationship target of `xl/workbook.xml` per OPC (absolute, or relative to `xl/` with `.`/`..`). */
function resolveTarget(target: string): string | null {
  const parts = target.startsWith('/') ? [] : ['xl'];
  for (const seg of (target.startsWith('/') ? target.slice(1) : target).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * The archive path of the first sheet (P27): the first `<sheet>` of `xl/workbook.xml` whatever its type, its
 * relationship target resolved per OPC. A relationship that is missing, external or not of the worksheet type → null
 * (the caller answers 415 {allowed}). Both parts must be well-formed; the workbook part must be SpreadsheetML.
 */
export function firstSheetPath(workbook: string, rels: string): string | null {
  let rid: string | undefined;
  let found = false;
  const guard = spreadsheetGuard('workbook');
  scanXml(
    workbook,
    (name) => name === 'sheet',
    (t) => {
      if (!guard(t) || t.end || t.name !== 'sheet' || found) return;
      found = true;
      rid = t.attrs.get(`{${R_NS}}id`);
    },
  );
  if (!rid) return null;
  let target: string | null = null;
  scanXml(
    rels,
    (name) => name === 'Relationship',
    (t) => {
      if (t.end || t.name !== 'Relationship' || t.ns !== PKG_NS || t.attrs.get('Id') !== rid) return;
      if (t.attrs.get('Type') !== WORKSHEET_TYPE || t.attrs.get('TargetMode') === 'External') return;
      target = resolveTarget(t.attrs.get('Target') ?? '');
    },
  );
  return target;
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

/** A cell reference: 1–3 upper-case column letters then its row number, no `$`, no space; else null. */
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

/**
 * The first sheet (P24–P27), in document order; the first violation wins, and on one element a malformed reference
 * wins over a limit:
 * - namespace-well-formed XML; SpreadsheetML rules (`spreadsheetGuard`) → otherwise malformed (415);
 * - every SpreadsheetML `<row>` has an unprefixed `r` = a positive integer (no sign, leading zero or fraction,
 *   ≤ 1 048 576), strictly increasing through the part; every `<c>` is inside a `<row>` and has an unprefixed `r` =
 *   an upper-case A1 reference without `$` whose row is that row's number, columns strictly increasing within the
 *   row → otherwise malformed (415);
 * - ≤ `maxRows` `<row>` elements (empty ones included), ≤ `maxCellsPerRow` `<c>` elements in a row and no cell
 *   beyond that column (`BL`) → otherwise too large, raised as soon as it is exceeded.
 */
export function prescanSheet(text: string, limits = SCAN_LIMITS): void {
  let rows = 0;
  let cells = 0;
  let inRow = false;
  let lastRow = 0;
  let lastCol = 0;
  const guard = spreadsheetGuard('worksheet');
  scanXml(
    text,
    (name) => name === 'c' || name === 'row',
    (t) => {
      if (!guard(t)) return;
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
 * The shared strings: namespace-well-formed SpreadsheetML (root `sst`); ≤ `maxStrings` `<si>` items and
 * ≤ `maxRuns` rich-text runs (`<r>`) in all.
 */
export function prescanSharedStrings(text: string, limits = SCAN_LIMITS): void {
  let strings = 0;
  let runs = 0;
  const guard = spreadsheetGuard('sst');
  scanXml(
    text,
    () => false,
    (t) => {
      if (!guard(t) || t.end) return;
      if (t.name === 'si' && ++strings > limits.maxStrings) throw new ScanError('tooLarge');
      if (t.name === 'r' && ++runs > limits.maxRuns) throw new ScanError('tooLarge');
    },
  );
}
