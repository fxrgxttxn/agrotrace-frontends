import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../src/domain/svg.js';
import { SVG_CASES } from './svg-cases.js';

type Recorded = { ok: false; tooComplex: boolean } | { ok: true; svg: string };
const express = JSON.parse(readFileSync(new URL('./fixtures/svg-express.json', import.meta.url), 'utf8')) as Record<string, Recorded>;

const KNOWN: Record<string, { why: string; mock: string | null }> = {
  attrCharRefWhitespace: { why: 'attribute whitespace', mock: null },
  xlinkRedeclEvilNested: {
    why: 'XLink prefix rebound',
    mock: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g xmlns:xlink="http://evil.example/"><a xmlns:ns1="http://www.w3.org/1999/xlink" ns1:href="#r"><rect id="r"/></a></g></svg>',
  },
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
