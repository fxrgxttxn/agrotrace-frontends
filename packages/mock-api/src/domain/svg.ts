/**
 * SVG logo sanitization (P15, P17, P18, P20) — the Express backend's rules without a DOM (the mock runs in the page):
 *
 * 1. UTF-8 (fatal decoding); a streaming pre-scan (port of Express `scanSvg`): no `<!DOCTYPE>`/declarations, balanced
 *    tags, element names from the allowlist only (anything else — script, style, use, foreignObject, animation — is
 *    refused), complexity limits (depth 64, 5 000 elements, 100 attributes per element, 20 000 in all, 32 namespace
 *    declarations, attribute values ≤ 64 KiB → `svg-too-complex`).
 * 2. A real parse into a tree (matching end tags, well-formed attributes, entity references resolved); the root must be
 *    `svg` without a prefix in the SVG namespace.
 * 3. Attribute cleaning: `on*` handlers dropped; `style` keeps only allowlisted properties with plain values; fill,
 *    stroke, filter, mask, clip-path, marker-* dropped when they hold `\` or any `url(…)` but `url(#id)`; `href`/
 *    `xlink:href` only `#id` (or a raster data URI in `<image>`); any `url(` to outside, `@import`, `expression(`,
 *    `javascript:` drops the attribute.
 * 4. The tree is serialized again (comments, PIs and CDATA sections are dropped; text re-escaped).
 */
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
const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /[ \t\r\n]/;

export type SvgResult = { ok: true; svg: string } | { ok: false; tooComplex: boolean; why: string };
const refuse = (why: string): SvgResult => ({ ok: false, tooComplex: false, why });
const complex = (why: string): SvgResult => ({ ok: false, tooComplex: true, why });

interface El {
  name: string;
  attrs: [string, string][];
  children: (El | string)[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Resolves the predefined and character references; null — an unknown entity (not well-formed without a DTD). */
function decodeRefs(s: string): string | null {
  let bad = false;
  const out = s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);?/g, (m, ref: string) => {
    if (!m.endsWith(';')) {
      bad = true;
      return m;
    }
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(Number(ref.slice(1)));
    const v = ENTITIES[ref];
    if (v === undefined) bad = true;
    return v ?? m;
  });
  return bad ? null : out;
}

const esc = (s: string, attr: boolean): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(attr ? /"/g : /$^/g, '&quot;');

function parse(text: string): { root: El } | SvgResult {
  const n = text.length;
  const stack: El[] = [];
  let root: El | null = null;
  let elements = 0;
  let attrs = 0;
  let namespaces = 0;
  let i = 0;
  const pushText = (s: string): SvgResult | null => {
    if (stack.length === 0) return /\S/.test(s) ? refuse('text outside the root') : null;
    const d = decodeRefs(s);
    if (d === null) return refuse('undefined entity');
    stack[stack.length - 1]!.children.push(d);
    return null;
  };
  for (;;) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? n : lt);
    if (chunk) {
      const r = pushText(chunk);
      if (r) return r;
    }
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return refuse('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return refuse('unterminated CDATA');
      if (stack.length === 0) return refuse('CDATA outside the root');
      stack[stack.length - 1]!.children.push(text.slice(lt + 9, end));
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
      const name = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) return refuse('mismatched end tag');
      i = end + 1;
      continue;
    }
    NAME.lastIndex = lt + 1;
    const name = NAME.exec(text)?.[0];
    if (!name) return refuse('malformed start tag');
    if (!SVG_ELEMENTS.has(name)) return refuse(`element ${name} is not allowed`);
    if (stack.length === 0 && root) return refuse('more than one root element');
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) return complex('too many elements');
    const el: El = { name, attrs: [], children: [] };
    let j = lt + 1 + name.length;
    let selfClosing = false;
    for (;;) {
      const before = j;
      while (j < n && SPACE.test(text[j]!)) j++;
      if (j >= n) return refuse('unterminated start tag');
      if (text[j] === '>') break;
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 1;
        break;
      }
      if (j === before) return refuse('attributes must be separated by white space');
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
      const raw = text.slice(j + 1, end);
      if (raw.includes('<')) return refuse('`<` in an attribute value');
      const value = decodeRefs(raw);
      if (value === null) return refuse('undefined entity');
      if (el.attrs.some(([a]) => a === attr)) return refuse('duplicate attribute');
      el.attrs.push([attr, value]);
      j = end + 1;
      attrs += 1;
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) namespaces += 1;
      if (el.attrs.length > SVG_MAX_ATTRS_PER_ELEMENT) return complex('too many attributes on an element');
      if (attrs > SVG_MAX_ATTRS) return complex('too many attributes');
      if (namespaces > SVG_MAX_NAMESPACES) return complex('too many namespace declarations');
    }
    if (stack.length > 0) stack[stack.length - 1]!.children.push(el);
    else root = el;
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > SVG_MAX_DEPTH) return complex('nested too deeply');
    }
    i = j + 1;
  }
  if (!root) return refuse('no element');
  if (stack.length > 0) return refuse('unclosed element');
  return { root };
}

// ── cleaning ──

const STYLE_PROPERTIES = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'display', 'visibility']);
const STYLE_VALUE_FORBIDDEN = /url\s*\(|\\|image-set|@|expression\s*\(/i;
const CSS_ATTRIBUTE = /^(fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end|marker)$/;
const LOCAL_URL = /url\(\s*#[A-Za-z_][\w.-]*\s*\)/gi;
const RASTER_DATA_URI = /^\s*data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const URL_TARGET = /url\s*\(\s*(['"]?)([^'")]*)/gi;

export function safeCssAttribute(value: string): boolean {
  if (value.includes('\\') || /expression\s*\(/i.test(value)) return false;
  return (value.match(/url\s*\(/gi) ?? []).length === (value.match(LOCAL_URL) ?? []).length;
}

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

function cleanAttrs(el: El): void {
  const out: [string, string][] = [];
  for (const [name, value] of el.attrs) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) continue;
    if (lower === 'style') {
      const v = cleanStyle(value);
      if (v) out.push([name, v]);
      continue;
    }
    if (CSS_ATTRIBUTE.test(lower) && !safeCssAttribute(value)) continue;
    if (lower === 'href' || lower === 'xlink:href') {
      const dataImage = el.name === 'image' && RASTER_DATA_URI.test(value);
      if (!/^\s*#/.test(value) && !dataImage) continue;
    }
    const targets = [...value.matchAll(URL_TARGET)].map((m) => m[2] ?? '');
    if (targets.some((t) => !/^\s*#/.test(t)) || /@import|expression\s*\(|javascript:/i.test(value)) continue;
    out.push([name, value]);
  }
  el.attrs = out;
  for (const c of el.children) if (typeof c !== 'string') cleanAttrs(c);
}

function serialize(el: El): string {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${esc(v, true)}"`).join('');
  if (el.children.length === 0) return `<${el.name}${attrs}/>`;
  return `<${el.name}${attrs}>${el.children.map((c) => (typeof c === 'string' ? esc(c, false) : serialize(c))).join('')}</${el.name}>`;
}

/** The sanitized SVG, or why it is refused. */
export function sanitizeSvg(bytes: Uint8Array): SvgResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('not UTF-8');
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const parsed = parse(text);
  if ('ok' in parsed) return parsed;
  const root = parsed.root;
  if (root.name !== 'svg') return refuse('root is not svg');
  const ns = root.attrs.find(([k]) => k === 'xmlns')?.[1];
  if (ns !== SVG_NS) return refuse('root not in the SVG namespace');
  cleanAttrs(root);
  return { ok: true, svg: `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root)}` };
}
