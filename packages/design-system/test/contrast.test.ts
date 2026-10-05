import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/'/g, '"');

function block(selector: string, source = css): Record<string, string> {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const decls: Record<string, string> = {};
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return decls;
  }
  throw new Error(`no rule for ${selector} in tokens.css`);
}

function mediaDark(): Record<string, string> {
  const m = /@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?\})\s*\}/.exec(css);
  if (!m) throw new Error('no prefers-color-scheme: dark block in tokens.css');
  return block(':root:not([data-theme="light"])', m[1]);
}

const light = block(':root');
const dark = block(':root[data-theme="dark"]');

function hex(theme: Record<string, string>, name: string): string {
  const v = theme[name];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a #rrggbb color: ${v}`);
  return v;
}

function luminance(color: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const GROUPS = ['neutral', 'attention', 'ok', 'move', 'danger', 'danger-solid'];
const PAIRS: [fg: string, bg: string, min: number][] = [
  ['--c-ink', '--c-ground', 4.5],
  ['--c-ink', '--c-surface', 4.5],
  ['--c-ink', '--c-surface-sunk', 4.5],
  ['--c-ink-muted', '--c-surface', 4.5],
  ['--c-ink-muted', '--c-ground', 4.5],
  ['--c-ink-disabled', '--c-surface-sunk', 4.5],
  ['--c-field-ink', '--c-field', 4.5],
  ['--c-field-ink', '--c-field-hover', 4.5],
  ['--c-field', '--c-surface', 4.5],
  ['--c-clay', '--c-surface', 4.5],
  ['--c-clay', '--c-ground', 4.5],
  ['--status-attention-fg', '--c-surface', 4.5],
  ['--status-attention-fg', '--c-ground', 4.5],
  ['--status-danger-fg', '--c-surface', 4.5],
  ['--c-line-strong', '--c-surface', 3],
  ['--c-line-strong', '--c-ground', 3],
  ['--c-field-ink', '--c-clay', 4.5],
  ['--c-field-ink', '--c-clay-hover', 4.5],
  ['--c-ink', '--c-straw-soft', 4.5],
  ['--c-ink-muted', '--c-straw-soft', 4.5],
  ['--c-straw-ink', '--c-straw', 4.5],
  ['--c-focus', '--c-ground', 3],
  ['--c-focus', '--c-surface', 3],
  ...GROUPS.map((g): [string, string, number] => [`--status-${g}-fg`, `--status-${g}-bg`, 4.5]),
];

describe('tokens.css contrast (WCAG AA)', () => {
  it('ratio() matches known WCAG values', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('both themes define the same colour tokens (no silent fallback to light)', () => {
    const colours = (t: Record<string, string>) =>
      Object.keys(t)
        .filter((k) => k.startsWith('--'))
        .sort();
    expect(colours(dark)).toEqual(colours(light));
  });

  it('hex() refuses a token missing from the theme', () => {
    expect(() => hex({}, '--c-ink')).toThrow();
  });

  it('the media-query dark block equals the explicit [data-theme="dark"] block', () => {
    expect(mediaDark()).toEqual(dark);
  });

  for (const [themeName, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${themeName}: ${fg} on ${bg} ≥ ${min}`, () => {
        expect(ratio(hex(theme, fg), hex(theme, bg))).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
