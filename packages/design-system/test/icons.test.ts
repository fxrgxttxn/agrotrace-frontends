import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSprite, compact } from '../scripts/build-sprite.ts';
import { literalColors } from './literal-colors.ts';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const ICONS = [
  'field',
  'batch',
  'waybill',
  'flask',
  'recall',
  'qr',
  'graph',
  'scale',
  'truck',
  'factory',
  'store',
  'shield',
  'alert',
  'check',
  'close',
  'plus',
  'minus',
  'search',
  'filter',
  'sort',
  'chevron-left',
  'chevron-right',
  'chevron-down',
  'bell',
  'user',
  'users',
  'building',
  'map',
  'calendar',
  'clock',
  'upload',
  'download',
  'file-pdf',
  'image',
  'logout',
  'settings',
  'menu',
  'more',
  'eye',
  'trash',
];
const ILLUSTRATIONS = [
  'empty-fields',
  'empty-batches',
  'empty-waybills',
  'empty-lab',
  'empty-recalls',
  'empty-complaints',
  'empty-notifications',
  'empty-search',
  'not-found',
  'forbidden',
  'login',
  'recall-warning',
];

type El = { name: string; attrs: Record<string, string> };
function elements(svg: string): El[] {
  const out: El[] = [];
  for (const m of svg.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    out.push({ name: m[1]!, attrs });
  }
  return out;
}
function unparsed(svg: string): string[] {
  const tags = svg.match(/<[^>]*>/g) ?? [];
  return tags.filter((t) => !/^<\/?[a-zA-Z][\w:-]*(?:\s+[\w:-]+="[^"]*")*\s*\/?>$/.test(t));
}

type Box = [number, number, number, number];
const grow = (b: Box, x: number, y: number): Box => [
  Math.min(b[0], x),
  Math.min(b[1], y),
  Math.max(b[2], x),
  Math.max(b[3], y),
];
const EMPTY: Box = [Infinity, Infinity, -Infinity, -Infinity];

function arcPoints(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  fa: number,
  fs: number,
  x2: number,
  y2: number,
) {
  const phi = (phiDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) [rx, ry] = [rx * Math.sqrt(lambda), ry * Math.sqrt(lambda)];
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const k = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const t = t1 + (dt * i) / 64;
    const [ex, ey] = [rx * Math.cos(t), ry * Math.sin(t)];
    pts.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return pts;
}

export function pathBox(d: string): Box {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let box = EMPTY;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-zA-Z]/.test(t)) throw new Error(`bad path data: ${d}`);
    return Number(t);
  };
  const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (!cmd || cmd.toLowerCase() === 'z') throw new Error(`bad path data: ${d}`);
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toLowerCase();
    if (!(c in ARITY)) throw new Error(`unknown command ${cmd} in ${d}`);
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (c === 'z') {
      [x, y] = [sx, sy];
      continue;
    }
    if (c === 'h') x = ox + num();
    else if (c === 'v') y = oy + num();
    else if (c === 'a') {
      const [rx, ry, rot, fa, fs] = [num(), num(), num(), num(), num()];
      const [nx, ny] = [ox + num(), oy + num()];
      for (const [px, py] of arcPoints(x, y, rx, ry, rot, fa, fs, nx, ny)) box = grow(box, px, py);
      [x, y] = [nx, ny];
    } else {
      const n = ARITY[c]!;
      for (let k = 0; k < n; k += 2) {
        const [px, py] = [ox + num(), oy + num()];
        box = grow(box, px, py);
        if (k === n - 2) [x, y] = [px, py];
      }
    }
    box = grow(box, x, y);
    if (c === 'm') {
      [sx, sy] = [x, y];
      cmd = rel ? 'l' : 'L';
    }
  }
  return box;
}

function elementBox(el: El): Box {
  const n = (k: string) => Number(el.attrs[k] ?? 0);
  switch (el.name) {
    case 'path':
      return pathBox(el.attrs.d ?? '');
    case 'circle':
      return [n('cx') - n('r'), n('cy') - n('r'), n('cx') + n('r'), n('cy') + n('r')];
    case 'rect':
      return [n('x'), n('y'), n('x') + n('width'), n('y') + n('height')];
    case 'line':
      return [
        Math.min(n('x1'), n('x2')),
        Math.min(n('y1'), n('y2')),
        Math.max(n('x1'), n('x2')),
        Math.max(n('y1'), n('y2')),
      ];
    case 'polyline': {
      const v = (el.attrs.points ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      let b = EMPTY;
      for (let k = 0; k < v.length; k += 2) b = grow(b, v[k]!, v[k + 1]!);
      return b;
    }
    default:
      throw new Error(`no geometry for <${el.name}>`);
  }
}

describe('path bounding box helper', () => {
  it('handles relative commands, implicit linetos and arcs', () => {
    expect(pathBox('M2 3h4v5l-1 1z')).toEqual([2, 3, 6, 9]);
    expect(pathBox('M4 4 10 10 6 12')).toEqual([4, 4, 10, 12]);
    const [x0, y0, x1, y1] = pathBox('M7 10a5 5 0 0 1 10 0');
    expect([x0, x1, y1]).toEqual([7, 17, 10]);
    expect(y0).toBeCloseTo(5, 5);
    expect(() => pathBox('M2 2 L')).toThrow();
  });
});

const manifest = JSON.parse(read('icons/manifest.json')) as unknown;

const ROOT_ATTRS = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.75',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};
const SHAPES: Record<string, string[]> = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height', 'rx'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
};

describe('icons', () => {
  it('manifest lists exactly the 40 contract names, in contract order', () => {
    expect(manifest).toEqual(ICONS);
  });

  it('icons/ holds exactly the manifest files', () => {
    const files = readdirSync(join(root, 'icons'))
      .filter((f) => f !== 'manifest.json')
      .sort();
    expect(files).toEqual(ICONS.map((n) => `${n}.svg`).sort());
  });

  for (const name of ICONS) {
    describe(name, () => {
      const file = `icons/${name}.svg`;
      const src = existsSync(join(root, file)) ? read(file) : '';
      const els = elements(src);
      const [svg, ...shapes] = els;

      it('root <svg> carries exactly the stroke rules', () => {
        expect(src.trim().endsWith('</svg>')).toBe(true);
        expect(unparsed(src).filter((t) => t !== '</svg>')).toEqual([]);
        expect(svg?.name).toBe('svg');
        expect(svg?.attrs).toEqual(ROOT_ATTRS);
      });

      it('children are geometry only: no colors, widths, transforms, styles or ids', () => {
        expect(shapes.length).toBeGreaterThan(0);
        for (const el of shapes) {
          expect(Object.keys(SHAPES), `<${el.name}>`).toContain(el.name);
          for (const a of Object.keys(el.attrs)) expect(SHAPES[el.name], `${el.name}[${a}]`).toContain(a);
        }
      });

      it('geometry stays inside the 2 px safe padding (2…22)', () => {
        for (const el of shapes) {
          const [x0, y0, x1, y1] = elementBox(el);
          const where = `${el.name} ${JSON.stringify(el.attrs)}`;
          expect(Math.min(x0, y0), where).toBeGreaterThanOrEqual(2 - 1e-6);
          expect(Math.max(x1, y1), where).toBeLessThanOrEqual(22 + 1e-6);
        }
      });

      it('rounded containers share the family radii (1.5 or 2)', () => {
        for (const el of shapes.filter((e) => e.name === 'rect'))
          expect(['1.5', '2'], JSON.stringify(el.attrs)).toContain(el.attrs.rx);
      });
    });
  }
});

describe('sprite.svg', () => {
  const sprite = read('sprite.svg');

  it('is up to date with the icon files (pnpm --filter @agrotrace/design-system build:sprite)', () => {
    expect(sprite).toBe(buildSprite(root));
  });

  it('holds exactly one symbol per manifest name, in manifest order, with the icon rules', () => {
    const symbols = elements(sprite).filter((e) => e.name === 'symbol');
    expect(symbols.map((s) => s.attrs.id)).toEqual(ICONS.map((n) => `i-${n}`));
    for (const s of symbols) {
      const rules: Record<string, string> = { ...ROOT_ATTRS };
      delete rules.xmlns;
      expect(s.attrs).toEqual({ id: s.attrs.id, ...rules });
    }
  });

  it('compact() drops whitespace between tags and collapses it inside multi-line tags', () => {
    const multiLine = `
  <path
    d="M2 2
      L4 4"
  />
  <circle cx="1"   r="2" />
`;
    expect(compact(multiLine)).toBe('<path d="M2 2 L4 4" /><circle cx="1" r="2" />');
  });

  it('each symbol body equals its icon file body', () => {
    for (const name of ICONS) {
      const body = /<symbol id="i-[^"]+"[^>]*>([\s\S]*?)<\/symbol>/.exec(
        sprite.slice(sprite.indexOf(`id="i-${name}"`) - 8),
      )?.[1];
      const file = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(read(`icons/${name}.svg`))?.[1];
      expect(body, name).toBe(compact(file ?? ''));
    }
  });
});

const tokens = read('tokens.css');
function themeTokens(): { light: Set<string>; dark: Set<string> } {
  const block = (start: number) => {
    const open = tokens.indexOf('{', start);
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
      if (tokens[k] === '{') depth++;
      if (tokens[k] === '}' && --depth === 0) return tokens.slice(open, k);
    }
    return '';
  };
  const names = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  return {
    light: names(block(tokens.indexOf(':root'))),
    dark: names(block(tokens.indexOf(":root[data-theme='dark']"))),
  };
}

const ILLU_ELEMENTS = ['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'];
const ILLU_ATTRS = new Set([
  'xmlns',
  'viewBox',
  'style',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'width',
  'height',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'opacity',
]);

describe('illustrations', () => {
  const { light, dark } = themeTokens();

  it('theme token blocks were found', () => {
    expect(light.has('--c-field')).toBe(true);
    expect(dark.has('--c-field')).toBe(true);
  });

  it('illustrations/ holds exactly the 12 contract files', () => {
    expect(readdirSync(join(root, 'illustrations')).sort()).toEqual(
      ILLUSTRATIONS.map((n) => `${n}.svg`).sort(),
    );
  });

  for (const name of ILLUSTRATIONS) {
    describe(name, () => {
      const file = `illustrations/${name}.svg`;
      const src = existsSync(join(root, file)) ? read(file) : '';
      const els = elements(src);

      it('is a 240×160 hand-written SVG under 6 KB', () => {
        expect(els[0]?.name).toBe('svg');
        expect(els[0]?.attrs).toEqual({ xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 240 160' });
        expect(statSync(join(root, file)).size).toBeLessThan(6 * 1024);
        expect(unparsed(src).filter((t) => !/^<\/(svg|g)>$/.test(t))).toEqual([]);
      });

      it('has no scripts, foreign objects, links, ids, styles sheets or event handlers', () => {
        expect(src).not.toMatch(
          /<script|<foreignObject|<style|<image|<use|<a[\s>]|href|url\(|@import|javascript:/i,
        );
        for (const el of els) {
          expect(ILLU_ELEMENTS, `<${el.name}>`).toContain(el.name);
          for (const a of Object.keys(el.attrs)) expect(ILLU_ATTRS.has(a), `${el.name}[${a}]`).toBe(true);
        }
      });

      it('every shape declares its paint: a fill token, or fill: none with a stroke token', () => {
        for (const el of els.filter((e) => !['svg', 'g'].includes(e.name))) {
          const decl = Object.fromEntries(
            (el.attrs.style ?? '')
              .split(';')
              .filter((s) => s.trim())
              .map((s) => s.split(':').map((p) => p.trim())),
          ) as Record<string, string>;
          const where = `${el.name} ${el.attrs.style ?? '(no style)'}`;
          expect(decl.fill, where).toBeDefined();
          if (decl.fill === 'none') expect(decl.stroke, where).toMatch(/^var\(--c-/);
        }
      });

      it('takes colors only from var(--c-…) tokens that exist in both themes, 3–4 of them', () => {
        const used = new Set<string>();
        for (const el of els) {
          const style = el.attrs.style ?? '';
          expect(literalColors(`x { ${style} }`), style).toEqual([]);
          for (const decl of style.split(';').filter((s) => s.trim())) {
            const [prop, value = ''] = decl.split(':').map((s) => s.trim());
            expect(['fill', 'stroke'], decl).toContain(prop);
            if (value === 'none') continue;
            const m = /^var\((--c-[\w-]+)\)$/.exec(value);
            expect(m, decl).not.toBeNull();
            used.add(m![1]!);
          }
        }
        for (const t of used) {
          expect(light.has(t), `${t} in light`).toBe(true);
          expect(dark.has(t), `${t} in dark`).toBe(true);
        }
        const palette = [...used].filter((t) => t !== '--c-surface');
        expect(palette.length, [...used].join(' ')).toBeGreaterThanOrEqual(3);
        expect(palette.length, [...used].join(' ')).toBeLessThanOrEqual(4);
        expect(used.has('--c-furrow-a') && used.has('--c-furrow-b'), 'furrow motif').toBe(true);
      });
    });
  }

  it('the icons showcase page shows every illustration', () => {
    const page = read('showcase/icons.html');
    for (const name of ILLUSTRATIONS) expect(page).toContain(`data-ds-art="${name}"`);
  });
});
