/**
 * SVG logo sanitization (spec 8.6: "SVG (санитизация от скриптов, хранится как есть)", Review Focus #5).
 *
 * 1. The upload must be UTF-8 without DTD entity declarations (no entity expansion, no external entities).
 * 2. It must be a well-formed XML document whose root is `svg` in the SVG namespace (jsdom's XML parser).
 * 3. DOMPurify with the SVG profiles removes scripts, event handlers (`on*`), `foreignObject`, animation elements that
 *    can set attributes, `javascript:` links; `style` elements are forbidden as well (`@import`, `url()` in CSS).
 * 4. A hook drops every external reference: `href`/`xlink:href` must point inside the document (`#id`) — except a
 *    raster `data:` URI in `<image>` — and any attribute with `url(…)` not starting with `#`, `@import`, `expression(`
 *    or `javascript:` is removed.
 * 5. The result is serialized as XML (XMLSerializer) and parsed again to prove it is well-formed.
 *
 * Returns the sanitized document (UTF-8), or null when the upload is not an acceptable SVG (the caller answers 415).
 */
import createDOMPurify, { type DOMPurify } from 'dompurify';
import { JSDOM } from 'jsdom';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Window = JSDOM['window'];
let engine: { window: Window; purify: DOMPurify } | null = null;

const isLocalRef = (v: string) => /^\s*#/.test(v);
const RASTER_DATA_URI = /^\s*data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const URL_TARGET = /url\s*\(\s*(['"]?)([^'")]*)/gi;

function getEngine() {
  if (engine) return engine;
  const { window } = new JSDOM('');
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue ?? '';
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

export function sanitizeSvg(bytes: Buffer): Buffer | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (/<!ENTITY/i.test(text)) return null;
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
  return Buffer.from(xml, 'utf8');
}
