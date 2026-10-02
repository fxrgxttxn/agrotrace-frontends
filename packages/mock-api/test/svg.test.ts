/**
 * The mock's SVG sanitizer against Express's (fix round 2, Important 2): every probe document of svg-cases.ts gives
 * the result backend-express gave (test/fixtures/svg-express.json, recorded by scripts/svg-express-probe.ts) —
 * refused (and whether as too complex) or the same sanitized document — and never throws. The allowlists copied from
 * DOMPurify and jsdom (src/domain/svg-profile.ts) are checked against the installed packages.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../src/domain/svg.js';
import { ALLOWED_ATTRS, CLOBBERING_NAMES } from '../src/domain/svg-profile.js';
import { SVG_CASES } from './svg-cases.js';

type Recorded = { ok: false; tooComplex: boolean } | { ok: true; svg: string };
const express = JSON.parse(readFileSync(new URL('./fixtures/svg-express.json', import.meta.url), 'utf8')) as Record<string, Recorded>;

/**
 * Documents where the mock differs from Express (why, and what the mock gives instead — `null`: Express's output with
 * `&#x9;`/`&#xA;` read as spaces).
 */
const KNOWN: Record<string, { why: string; mock: string | null }> = {
  // An XML parser normalizes a literal tab/newline of an attribute value to a space; Express's DOM keeps it and
  // XMLSerializer writes `&#xA;`. Both render the same.
  attrCharRefWhitespace: { why: 'attribute whitespace', mock: null },
  // Express serializes the XLink attribute with the `xlink` prefix, which the inner declaration binds to another
  // namespace — the stored file's `xlink:href` is then NOT an XLink href. The mock declares a fresh prefix for the
  // XLink namespace (what the DOM holds). Both keep only the local `#r`; the mock's file means what it says.
  xlinkRedeclEvilNested: {
    why: 'XLink prefix rebound',
    mock: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g xmlns:xlink="http://evil.example/"><a xmlns:ns1="http://www.w3.org/1999/xlink" ns1:href="#r"><rect id="r"/></a></g></svg>',
  },
  // DOMPurify parses the text as HTML: inside <title> (an HTML integration point) a CDATA section is a bogus comment
  // up to the first `>` — Express keeps `x]]>`. The mock keeps the CDATA text, escaped. Both are plain text.
  cdataInTitle: { why: 'CDATA in an HTML integration point', mock: '<svg xmlns="http://www.w3.org/2000/svg"><title>&lt;b&gt;x&lt;/b&gt;</title></svg>' },
};

describe('SVG sanitizer = Express', () => {
  it('records a result for every case', () => {
    expect(Object.keys(express).sort()).toEqual(Object.keys(SVG_CASES).sort());
  });

  for (const [name, doc] of Object.entries(SVG_CASES)) {
    it(name, () => {
      const mine = sanitizeSvg(new TextEncoder().encode(doc));
      const theirs = express[name]!;
      if (!theirs.ok) {
        expect(mine.ok, mine.ok ? mine.svg : '').toBe(false);
        if (!mine.ok) expect(mine.tooComplex).toBe(theirs.tooComplex);
        return;
      }
      expect(mine.ok, mine.ok ? '' : mine.why).toBe(true);
      if (!mine.ok) return;
      const known = KNOWN[name];
      if (!known) expect(mine.svg).toBe(theirs.svg);
      else if (known.mock === null) expect(mine.svg.replace(/&#x[9A];/g, ' ')).toBe(theirs.svg.replace(/&#x[9A];/g, ' '));
      else {
        expect(theirs.svg, `${name}: Express changed — re-check the KNOWN difference`).not.toBe(known.mock);
        expect(mine.svg).toBe(known.mock);
      }
    });
  }
});

describe('the copied profiles match the installed packages', () => {
  const require = createRequire(new URL('../../../backend-express/package.json', import.meta.url));

  it('DOMPurify svg + svgFilters + xml attributes', () => {
    const src = readFileSync(new URL('purify.es.mjs', pathToFileURL(require.resolve('dompurify'))), 'utf8');
    const list = (name: string) => [...new RegExp(`const ${name.replace('$', '\\$')} = freeze\\(\\[([^\\]]*)\\]`).exec(src)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set([...list('svg'), ...list('xml')])).toEqual(ALLOWED_ATTRS);
  });

  it('DOM clobbering names (jsdom document and form)', async () => {
    const { JSDOM } = require('jsdom') as typeof import('jsdom');
    const d = new JSDOM('').window.document;
    const names = new Set<string>();
    for (const root of [d, d.createElement('form')]) for (let o: object | null = root; o; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) names.add(k);
    expect(names).toEqual(CLOBBERING_NAMES);
  });
});
