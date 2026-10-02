import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };
import { createT } from '../src/index.js';
import { PUBLIC_KEYS, pickPublic } from '../src/public-keys.js';
import { publicT, problemMessage, enumLabel } from '../src/public.js';
import { PHOTO_CREDITS, photoCredit } from '../src/photo-credits.js';

// Ruling FM35: the public QR page (/p/*) bundles only the keys it needs, of the active locale only —
// `@agrotrace/i18n/public` (translation function, formatters, problem text) + `@agrotrace/i18n/public/<locale>.json`
// (generated subset, committed; `pnpm --filter @agrotrace/i18n build:public` rewrites it).

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const subset = (locale: 'ru' | 'en') => JSON.parse(readFileSync(here(`../public/${locale}.json`), 'utf8'));

function leaves(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('public dictionary subset (FM35)', () => {
  it.each([
    ['ru', ru],
    ['en', en],
  ] as const)(
    '%s: the committed public/<locale>.json is the projection of the full dictionary',
    (locale, full) => {
      expect(subset(locale)).toEqual(pickPublic(full));
    },
  );

  it.each([
    ['ru', ru],
    ['en', en],
  ] as const)('%s: every public key exists', (_locale, full) => {
    for (const key of PUBLIC_KEYS) {
      const node = key
        .split('.')
        .reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], full);
      expect(node, key).toBeDefined();
    }
  });

  it.each(['ru', 'en'] as const)('%s: no plural templates (publicT has no plural support)', (locale) => {
    for (const [key, text] of leaves(subset(locale))) expect(text, key).not.toMatch(/\{\w+,\s*plural,/);
  });

  it('is a small part of the full dictionary', () => {
    const size = (o: unknown) => JSON.stringify(o).length;
    expect(size(subset('ru'))).toBeLessThan(size(ru) / 10);
  });

  it.each(['ru', 'en'] as const)('%s: publicT translates every subset key exactly as createT', (locale) => {
    const full = createT(locale);
    const t = publicT(subset(locale), locale);
    for (const [key] of leaves(subset(locale))) expect(t(key)).toBe(full(key));
    expect(t('auth.retryIn', { seconds: 5 })).toBe(full('auth.retryIn', { seconds: 5 }));
    expect(t.locale).toBe(locale);
  });

  it('problem texts and enum labels work on the subset (unknown codes → errors.UNKNOWN)', () => {
    const t = publicT(subset('ru'), 'ru');
    expect(problemMessage({ code: 'CAPTCHA_FAILED' }, t)).toBe(ru.errors.CAPTCHA_FAILED);
    expect(problemMessage({ code: 'GRAPH_CYCLE' }, t)).toBe(ru.errors.UNKNOWN);
    expect(enumLabel(t, 'SafetyStatus', 'RECALLED')).toBe('Отозвана');
    expect(enumLabel(t, 'OrganizationType', 'FARM')).toBe('Хозяйство');
  });

  it('the public entry never imports the full dictionaries', () => {
    const graph = [
      'public.ts',
      'translate.ts',
      'format.ts',
      'local-date.ts',
      'resolve.ts',
      'problem.ts',
      'enum-labels.ts',
      'photo-credits.ts',
    ];
    for (const file of graph) {
      const src = readFileSync(here(`../src/${file}`), 'utf8');
      expect(src, file).not.toMatch(/locales\//);
      for (const m of src.matchAll(/from '\.\/([\w-]+)\.js'/g))
        expect(graph, `${file} → ${m[1]}`).toContain(`${m[1]}.ts`);
    }
  });
});

describe('product photo credits (R76 note)', () => {
  const products = JSON.parse(readFileSync(here('../../../db/seed/data/products.json'), 'utf8')) as {
    name: string;
    image?: string;
  }[];
  const rows = readFileSync(here('../../../db/seed/ATTRIBUTION.md'), 'utf8')
    .split('\n')
    .filter((l) => /^\| `[\w-]+\.jpg` \|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()));

  it('follows db/seed/ATTRIBUTION.md for every seed product photo', () => {
    expect(rows.length).toBeGreaterThan(0);
    const expected: Record<string, unknown> = {};
    for (const p of products) {
      const row = rows.find((r) => r[1] === `\`${p.image}\``);
      expect(row, p.name).toBeDefined();
      const license = /^\[(.+)\]\((.+)\)$/.exec(row![4]!)!;
      expected[p.name] = {
        author: row![3],
        license: license[1],
        licenseUrl: license[2],
        source: row![5]!.replace(/^<|>$/g, ''),
      };
    }
    expect(PHOTO_CREDITS).toEqual(expected);
  });

  it('photoCredit finds a product by name, null otherwise', () => {
    expect(photoCredit('Пшеница мягкая')?.author).toBe('Raman Deep');
    expect(photoCredit('Пшеница озимая')).toBeNull();
  });
});
