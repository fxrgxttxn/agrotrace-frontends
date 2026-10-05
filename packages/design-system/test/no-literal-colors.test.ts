import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { literalColors } from './literal-colors.ts';

const root = join(__dirname, '..');
const files = [
  'base.css',
  ...readdirSync(join(root, 'components'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `components/${f}`),
];

describe('no literal colors outside tokens.css', () => {
  it('detects literals and ignores var() fallbacks', () => {
    expect(
      literalColors('a { color: #fff; background: rgb(0 0 0 / .5); border-color: hsl(0 0% 0%) }'),
    ).toEqual(['#fff', 'rgb(', 'hsl(']);
    expect(literalColors('a { color: var(--c-ink, #33291f); /* #abc */ }')).toEqual([]);
  });

  it('detects modern color functions and named colors', () => {
    expect(
      literalColors(
        'a { color: oklch(60% .1 120); fill: lab(50 0 0); stroke: hwb(0 0% 0%); background: color-mix(in srgb, var(--c-ink), white) }',
      ),
    ).toEqual(['oklch(', 'lab(', 'hwb(', 'color-mix(', 'white']);
    expect(literalColors('.x { border: 1px solid red; outline-color: Tomato }')).toEqual(['red', 'tomato']);
    expect(
      literalColors(
        '.x { text-decoration: underline wavy red; text-shadow: 0 1px 0 black; text-emphasis-color: #abc }',
      ),
    ).toEqual(['#abc', 'red', 'black']);
  });

  it('keeps keywords, selectors, custom property names and non-color values', () => {
    expect(
      literalColors(
        ".at-field .red, .tan { color: currentColor; background: transparent; content: 'white'; " +
          'grid-template-areas: "label value"; --green: 1px; font-family: var(--font-body) }',
      ),
    ).toEqual([]);
  });

  it('covers every component file', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  for (const f of files) {
    it(f, () => {
      expect(literalColors(readFileSync(join(root, f), 'utf8'))).toEqual([]);
    });
  }
});
