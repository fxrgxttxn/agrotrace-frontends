/**
 * SVG logo sanitization (P15, P17, P18, P20, FM8) — Express's pipeline (backend-express/src/infra/svg.ts and
 * svg-sanitize.ts) without a DOM, since the mock runs in the page:
 *
 * 1. UTF-8 (fatal decoding) and Express's streaming pre-scan `scanSvg`, ported as is: no `<!DOCTYPE>`/declarations,
 *    balanced tags, element names from the allowlist only (script, style, use, foreignObject, animation… are refused),
 *    complexity limits (depth 64, 5 000 elements, 100 attributes per element, 20 000 in all, 32 namespace
 *    declarations, attribute values ≤ 64 KiB → `svg-too-complex`).
 * 2. A strict, namespace-aware XML parse (saxes, `xmlns: true` — jsdom's own XML parser): anything not well-formed is
 *    refused — invalid character references (`&#0;`, `&#x110000;`), a bare `&`, `]]>` in text, unbound prefixes,
 *    duplicate attributes. The root must be `svg` in the SVG namespace.
 * 3. What DOMPurify then does in Express, which parses the text again as HTML (USE_PROFILES svg + svgFilters,
 *    FORBID_TAGS style/foreignObject/script) with Express's attribute hook:
 *    - every element is SVG (an inner `xmlns` switching to XHTML is ignored and dropped, as the HTML parser does);
 *      inside `title`/`desc` (HTML integration points) the first element other than `svg` and everything after it is
 *      removed; comments, processing instructions and CDATA markers go (CDATA text stays);
 *    - attribute names are lower-cased (the first of duplicates wins) and must be in DOMPurify's svg/xml profile,
 *      `data-*` or `aria-*`; SVG names get their camelCase back (`viewBox`); a prefixed name is kept only as
 *      `xlink:href`, `xlink:title`, `xml:space`, `xml:id`, `xmlns:xlink` (so `x:href` bound to XLink and
 *      `xml:base` are dropped);
 *    - values are trimmed; Express's hook: `style` keeps allowlisted properties with plain values; fill, stroke,
 *      filter, mask, clip-path, marker-* only without `\` and with no `url(…)` but `url(#id)`; `href`/`xlink:href`
 *      only `#id` (or a raster data URI in `<image>`); any `url(` to outside, `@import`, `expression(`,
 *      `javascript:` drops the attribute;
 *    - DOMPurify's own checks: SAFE_FOR_XML (`-->`, `]>`, `</title`… in a value), `attributeName` naming href,
 *      `for`/`patchsrc`, DOM clobbering names as `id`/`name` values, and URI-like values of any other attribute
 *      (`^[a-z+.-]+:` other than http(s)/mailto/tel/…; `data:` only for `href` of `<image>`).
 * 4. Serialization as XMLSerializer does it: the root keeps its `xmlns`, redundant namespace declarations go, text is
 *    re-escaped. One known difference: a literal tab or newline inside an attribute value is normalized to a space by
 *    the XML parse (Express keeps it as `&#xA;`) — the same rendering.
 */
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';
import { ALLOWED_ATTRS, CLOBBERING_NAMES, SVG_ATTR_CASE } from './svg-profile.js';

export const SVG_MAX_DEPTH = 64;
export const SVG_MAX_ELEMENTS = 5000;
export const SVG_MAX_ATTRS_PER_ELEMENT = 100;
export const SVG_MAX_ATTRS = 20_000;
export const SVG_MAX_NAMESPACES = 32;
export const SVG_MAX_ATTR_VALUE = 64 * 1024;

// prettier-ignore
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'metadata', 'symbol', 'switch', 'a',
  'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect',
  'text', 'tspan', 'textPath', 'image',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export type SvgResult = { ok: true; svg: string } | { ok: false; tooComplex: boolean; why: string };
const refuse = (why: string): SvgResult => ({ ok: false, tooComplex: false, why });
const complex = (why: string): SvgResult => ({ ok: false, tooComplex: true, why });

// ── 1. the pre-scan (Express `scanSvg`) ──

const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /[ \t\r\n]/;

export function scanSvg(text: string): SvgResult | null {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let elements = 0;
  let attrs = 0;
  let namespaces = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (elements === 0) return refuse('no element');
      return depth === 0 ? null : refuse('unclosed element');
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return refuse('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return refuse('unterminated CDATA');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return refuse('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text[lt + 1] === '!') return refuse('declaration (DOCTYPE/ENTITY)');
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) return refuse('unterminated end tag');
      depth -= 1;
      if (depth < 0) return refuse('unbalanced end tag');
      i = end + 1;
      continue;
    }
    NAME.lastIndex = lt + 1;
    const name = NAME.exec(text)?.[0];
    if (!name) return refuse('malformed start tag');
    if (!SVG_ELEMENTS.has(name)) return refuse(`element ${name} is not allowed`);
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) return complex('too many elements');
    let j = lt + 1 + name.length;
    let own = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && SPACE.test(text[j]!)) j++;
      if (j >= n) return refuse('unterminated start tag');
      if (text[j] === '>') break;
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 1;
        break;
      }
      NAME.lastIndex = j;
      const attr = NAME.exec(text)?.[0];
      if (!attr) return refuse('malformed attribute');
      j += attr.length;
      while (j < n && SPACE.test(text[j]!)) j++;
      if (text[j] !== '=') return refuse('attribute without a value');
      j += 1;
      while (j < n && SPACE.test(text[j]!)) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return refuse('unquoted attribute value');
      const end = text.indexOf(quote, j + 1);
      if (end < 0) return refuse('unterminated attribute value');
      if (end - j - 1 > SVG_MAX_ATTR_VALUE) return complex('attribute value too long');
      if (text.slice(j + 1, end).includes('<')) return refuse('`<` in an attribute value');
      j = end + 1;
      own += 1;
      attrs += 1;
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) namespaces += 1;
      if (own > SVG_MAX_ATTRS_PER_ELEMENT) return complex('too many attributes on an element');
      if (attrs > SVG_MAX_ATTRS) return complex('too many attributes');
      if (namespaces > SVG_MAX_NAMESPACES) return complex('too many namespace declarations');
    }
    if (!selfClosing) {
      depth += 1;
      if (depth > SVG_MAX_DEPTH) return complex('nested too deeply');
    }
    i = j + 1;
  }
}

// ── 2. the XML parse ──

interface El {
  name: string;
  uri: string;
  selfClosing: boolean;
  attrs: SaxesAttributeNS[];
  children: (El | string)[];
}

/** The document tree, or why it is not well-formed namespace-aware XML. */
function parseXml(text: string): El | string {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: El[] = [];
  let root: El | null = null;
  let error: string | null = null;
  const addText = (t: string): void => {
    const top = stack.at(-1);
    if (!top) return;
    const last = top.children.at(-1);
    if (typeof last === 'string') top.children[top.children.length - 1] = last + t;
    else top.children.push(t);
  };
  parser.on('error', (e) => {
    error ??= e.message;
    throw e;
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    const el: El = { name: tag.name, uri: tag.uri, selfClosing: tag.isSelfClosing, attrs: Object.values(tag.attributes), children: [] };
    stack.at(-1)?.children.push(el);
    root ??= el;
    stack.push(el);
  });
  parser.on('closetag', () => void stack.pop());
  parser.on('text', addText);
  parser.on('cdata', addText);
  try {
    parser.write(text).close();
  } catch (e) {
    return error ?? String(e);
  }
  return root ?? 'no element';
}

// ── 3. the sanitizer (DOMPurify over the HTML parse + Express's hook) ──

const STYLE_PROPERTIES = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'display', 'visibility']);
const STYLE_VALUE_FORBIDDEN = /url\s*\(|\\|image-set|@|expression\s*\(/i;
const CSS_ATTRIBUTE = /^(fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end|marker)$/;
const LOCAL_URL = /url\(\s*#[A-Za-z_][\w.-]*\s*\)/gi;
const RASTER_DATA_URI = /^\s*data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const URL_TARGET = /url\s*\(\s*(['"]?)([^'")]*)/gi;
const isLocalRef = (v: string): boolean => /^\s*#/.test(v);

// DOMPurify 3.4.16
const SAFE_FOR_XML = /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i;
const DATA_ATTR = new RegExp('^data-[-\\w.\\u00B7-\\uFFFF]+$');
const ARIA_ATTR = /^aria-[-\w]+$/;
const IS_ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
const ATTR_WHITESPACE = new RegExp('[\\u0000-\\u0020\\u00A0\\u1680\\u180E\\u2000-\\u2029\\u205F\\u3000]', 'g');
const URI_SAFE_ATTRS = new Set(['alt', 'class', 'for', 'id', 'label', 'name', 'pattern', 'placeholder', 'role', 'summary', 'title', 'value', 'style', 'xmlns']);
/** The HTML parser puts these in the XLink / XML namespace (adjust foreign attributes); `xmlns:xlink` declares. */
const XLINK_ATTRS = new Set(['xlink:actuate', 'xlink:arcrole', 'xlink:href', 'xlink:role', 'xlink:show', 'xlink:title', 'xlink:type']);

/** Express `safeCssAttribute` (P20). */
export function safeCssAttribute(value: string): boolean {
  if (value.includes('\\') || /expression\s*\(/i.test(value)) return false;
  return (value.match(/url\s*\(/gi) ?? []).length === (value.match(LOCAL_URL) ?? []).length;
}

/** Express `cleanStyle` (P17). */
export function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!(STYLE_PROPERTIES.has(prop) || /^font-[a-z-]+$/.test(prop))) continue;
    if (value === '' || STYLE_VALUE_FORBIDDEN.test(value) || /[<>"]/.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.join('; ');
}

/** Express's `uponSanitizeAttribute` hook: the value to keep, or null. */
function hook(tag: string, name: string, value: string): string | null {
  if (name === 'style') {
    const v = cleanStyle(value);
    return v === '' ? null : v;
  }
  if (CSS_ATTRIBUTE.test(name) && !safeCssAttribute(value)) return null;
  if ((name === 'href' || name === 'xlink:href') && !isLocalRef(value) && !(tag === 'image' && RASTER_DATA_URI.test(value))) return null;
  const targets = [...value.matchAll(URL_TARGET)].map((m) => m[2] ?? '');
  if (targets.some((t) => !isLocalRef(t)) || /@import|expression\s*\(|javascript:/i.test(value)) return null;
  return value;
}

/** DOMPurify `_isValidAttribute` for this configuration. */
function validAttribute(tag: string, name: string, value: string): boolean {
  if (name === 'patchsrc' || (name === 'for' && tag !== 'label' && tag !== 'output')) return false;
  if ((name === 'id' || name === 'name') && CLOBBERING_NAMES.has(value)) return false;
  if (DATA_ATTR.test(name) || ARIA_ATTR.test(name)) return true;
  if (!ALLOWED_ATTRS.has(name)) return false;
  if (URI_SAFE_ATTRS.has(name)) return true;
  if (IS_ALLOWED_URI.test(value.replace(ATTR_WHITESPACE, ''))) return true;
  if ((name === 'href' || name === 'xlink:href') && value.startsWith('data:') && tag === 'image') return true;
  return value === '';
}

interface Out {
  name: string;
  attrs: { name: string; value: string; ns: 'xlink' | 'xml' | 'decl' | null }[];
  children: (Out | string)[];
}

function sanitizeElement(el: El): Out {
  const tag = el.name.toLowerCase();
  const out: Out = { name: el.name, attrs: [], children: [] };
  const seen = new Set<string>();
  for (const a of el.attrs) {
    const lc = a.name.toLowerCase();
    if (seen.has(lc)) continue; // the HTML parser keeps the first of duplicate names
    seen.add(lc);
    const value = hook(tag, lc, a.value.trim());
    if (value === null || SAFE_FOR_XML.test(value)) continue;
    if (lc === 'attributename' && value.includes('href')) continue;
    if (!validAttribute(tag, lc, value)) continue;
    const ns = XLINK_ATTRS.has(lc) ? 'xlink' : lc === 'xml:space' || lc === 'xml:lang' ? 'xml' : lc === 'xmlns' || lc === 'xmlns:xlink' ? 'decl' : null;
    out.attrs.push({ name: ns === null ? (SVG_ATTR_CASE[lc] ?? lc) : lc, value, ns });
  }
  const integrationPoint = el.name === 'title' || el.name === 'desc';
  for (const c of el.children) {
    if (typeof c === 'string') {
      out.children.push(c);
      continue;
    }
    if (integrationPoint && c.name !== 'svg') {
      // The HTML parser makes it an HTML element, removed with its content; written self-closing it stays open and
      // swallows the rest of the title/desc — except `<image>`, which becomes the void `<img>`.
      if (c.selfClosing && c.name !== 'image') break;
      continue;
    }
    out.children.push(sanitizeElement(c));
  }
  return out;
}

// ── 4. serialization (XMLSerializer) ──

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string =>
  escText(s).replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

function serialize(el: Out, isRoot: boolean, scope: Map<string, string>, gen: { n: number }): string {
  const inner = new Map(scope);
  let attrs = '';
  for (const a of el.attrs)
    if (a.ns === 'decl' && a.name === 'xmlns:xlink') {
      if (scope.get('xlink') === a.value) continue; // already declared so by an ancestor
      inner.set('xlink', a.value);
    }
  for (const a of el.attrs) {
    if (a.ns === 'decl') {
      if (a.name === 'xmlns') {
        if (isRoot) attrs += ` xmlns="${SVG_NS}"`;
      } else if (scope.get('xlink') !== a.value) attrs += ` xmlns:xlink="${escAttr(a.value)}"`;
      continue;
    }
    if (a.ns === 'xlink') {
      let prefix = [...inner].find(([, uri]) => uri === XLINK_NS)?.[0];
      if (prefix === undefined) {
        prefix = `ns${gen.n++}`;
        inner.set(prefix, XLINK_NS);
        attrs += ` xmlns:${prefix}="${XLINK_NS}"`;
      }
      attrs += ` ${prefix}:${a.name.slice(6)}="${escAttr(a.value)}"`;
      continue;
    }
    attrs += ` ${a.name}="${escAttr(a.value)}"`;
  }
  if (el.children.length === 0) return `<${el.name}${attrs}/>`;
  const body = el.children.map((c) => (typeof c === 'string' ? escText(c) : serialize(c, false, inner, gen))).join('');
  return `<${el.name}${attrs}>${body}</${el.name}>`;
}

/** The sanitized SVG (what Express stores), or why it is refused. */
export function sanitizeSvg(bytes: Uint8Array): SvgResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('not UTF-8');
  }
  const scanned = scanSvg(text);
  if (scanned) return scanned;
  const root = parseXml(text);
  if (typeof root === 'string') return refuse(`not well-formed: ${root}`);
  if (root.name !== 'svg' || root.uri !== SVG_NS) return refuse('the root is not svg in the SVG namespace');
  return { ok: true, svg: serialize(sanitizeElement(root), true, new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), { n: 1 }) };
}
