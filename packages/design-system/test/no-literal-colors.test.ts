// Components and base styles take every color from tokens.css: no hex, rgb() or hsl() literals
// outside var(…) expressions (fallbacks inside var() are tolerated, bare literals are not).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const files = [
  'base.css',
  ...readdirSync(join(root, 'components'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `components/${f}`),
];

export function literalColors(css: string): string[] {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop var(...) expressions, innermost first, until none are left.
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/var\([^()]*\)/g, '');
  }
  return s.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? [];
}

describe('no literal colors outside tokens.css', () => {
  it('detects literals and ignores var() fallbacks', () => {
    expect(
      literalColors('a { color: #fff; background: rgb(0 0 0 / .5); border-color: hsl(0 0% 0%) }'),
    ).toEqual(['#fff', 'rgb(', 'hsl(']);
    expect(literalColors('a { color: var(--c-ink, #33291f); /* #abc */ }')).toEqual([]);
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
