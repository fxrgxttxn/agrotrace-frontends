/**
 * The DOM part of SVG logo sanitization (spec 8.6, Review Focus #5, P15/P17). Runs inside the sanitizer worker
 * (svg-worker.ts) — never on the API's event loop — and only on documents that passed the streaming pre-scan
 * (svg.ts `scanSvg`: bounded depth and element count, no DOCTYPE).
 *
 * 1. The document must be well-formed XML whose root is `svg` in the SVG namespace (jsdom's XML parser).
 * 2. DOMPurify with the SVG profiles removes scripts, event handlers (`on*`), `foreignObject`, animation elements that
 *    can set attributes, `javascript:` links; `style` elements are forbidden as well.
 * 3. A hook drops every external reference: `href`/`xlink:href` must point inside the document (`#id`) — except a
 *    raster `data:` URI in `<image>` — and any attribute with `url(…)` not starting with `#`, `@import`, `expression(`
 *    or `javascript:` is removed. The `style` attribute keeps only allowlisted presentation properties whose values
 *    contain no `url(`, `\`, `image-set`, `@` or `expression(` (P17, P20); `fill`, `stroke`, `filter`, `mask`,
 *    `clip-path` and `marker-*` are dropped when they contain `\` or any `url(…)` other than `url(#id)` (P20).
 * 4. The result is serialized as XML (XMLSerializer) and parsed again to prove it is well-formed.
 *
 * Returns the sanitized document, or null when it is not an acceptable SVG.
 */
import createDOMPurify, { type DOMPurify } from 'dompurify';
import { JSDOM } from 'jsdom';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Window = JSDOM['window'];
let engine: { window: Window; purify: DOMPurify } | null = null;

const isLocalRef = (v: string) => /^\s*#/.test(v);
const RASTER_DATA_URI = /^\s*data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const URL_TARGET = /url\s*\(\s*(['"]?)([^'")]*)/gi;
const STYLE_PROPERTIES = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'text-anchor',
  'display',
  'visibility',
]);
const STYLE_VALUE_FORBIDDEN = /url\s*\(|\\|image-set|@|expression\s*\(/i;

/** P20: presentation attributes whose values CSS parses (escapes, `url()`); `style` is handled by `cleanStyle`. */
const CSS_ATTRIBUTE = /^(fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end|marker)$/;
const LOCAL_URL = /url\(\s*#[A-Za-z_][\w.-]*\s*\)/gi;

/**
 * A CSS-parsed attribute value is kept only without `\` (CSS escapes could hide `url(`) and with every `url(` being a
 * plain same-document reference `url(#id)` — gradients, clip paths and masks keep working (P20). The value is the
 * DOM's, i.e. already entity-decoded.
 */
export function safeCssAttribute(value: string): boolean {
  if (value.includes('\\') || /expression\s*\(/i.test(value)) return false;
  const urls = (value.match(/url\s*\(/gi) ?? []).length;
  return urls === (value.match(LOCAL_URL) ?? []).length;
}

/** P17: the declarations of a `style` attribute that are allowlisted presentation properties with plain values. */
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

function getEngine() {
  if (engine) return engine;
  const { window } = new JSDOM('');
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    if (name === 'style') {
      data.attrValue = cleanStyle(data.attrValue ?? '');
      if (data.attrValue === '') data.keepAttr = false;
      return;
    }
    const value = data.attrValue ?? '';
    if (CSS_ATTRIBUTE.test(name) && !safeCssAttribute(value)) {
      data.keepAttr = false;
      return;
    }
    if (name === 'href' || name === 'xlink:href') {
      const dataImage = node.nodeName.toLowerCase() === 'image' && RASTER_DATA_URI.test(value);
      if (!isLocalRef(value) && !dataImage) data.keepAttr = false;
    }
    const targets = [...value.matchAll(URL_TARGET)].map((m) => m[2] ?? '');
    if (targets.some((t) => !isLocalRef(t)) || /@import|expression\s*\(|javascript:/i.test(value))
      data.keepAttr = false;
  });
  engine = { window, purify };
  return engine;
}

function parseSvg(window: Window, text: string): Element | null {
  const doc = new window.DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const root = doc.documentElement;
  return root && root.namespaceURI === SVG_NS && root.localName === 'svg' ? root : null;
}

export function sanitizeSvgText(text: string): string | null {
  const { window, purify } = getEngine();
  if (!parseSvg(window, text)) return null;
  const fragment = purify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['style', 'foreignObject', 'script'],
    RETURN_DOM_FRAGMENT: true,
  });
  const roots = [...fragment.childNodes].filter((n) => n.nodeType === 1) as Element[];
  if (roots.length !== 1 || roots[0]!.namespaceURI !== SVG_NS || roots[0]!.localName !== 'svg') return null;
  const xml = new window.XMLSerializer().serializeToString(roots[0]!);
  if (!parseSvg(window, xml)) return null;
  return xml;
}
