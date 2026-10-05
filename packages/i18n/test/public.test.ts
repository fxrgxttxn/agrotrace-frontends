import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };
import { createT } from '../src/index.js';
import { PUBLIC_KEYS, pickPublic } from '../src/public-keys.js';
import { publicT, problemMessage, enumLabel } from '../src/public.js';
import { PHOTO_CREDITS, photoCredit } from '../src/photo-credits.js';
import { uuid } from '../../../db/seed/src/ids.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const subset = (locale: 'ru' | 'en') => JSON.parse(readFileSync(here(`../public/${locale}.json`), 'utf8'));

function leaves(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('public dictionary subset', () => {
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
    key: string;
    name: string;
    image?: string;
  }[];
  const fileId = (key: string) => uuid('file', `product:${key}`);
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
      expect(fileId(p.key)[14], `${p.name}: a v5 seed id`).toBe('5');
      expected[fileId(p.key).slice(0, 8)] = {
        author: row![3],
        license: license[1],
        licenseUrl: license[2],
        source: row![5]!.replace(/^<|>$/g, ''),
      };
    }
    expect(PHOTO_CREDITS).toEqual(expected);
  });

  it('photoCredit finds a seed photo by the file id of its URL, null for any other photo', () => {
    const wheat = fileId('wheat');
    expect(photoCredit(`/api/v1/public/files/${wheat}`)?.author).toBe('Raman Deep');
    expect(photoCredit(`https://cdn.example/api/v1/public/files/${wheat}?variant=480`)?.author).toBe(
      'Raman Deep',
    );
    expect(photoCredit('/api/v1/public/files/2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e')).toBeNull();
    expect(photoCredit('Пшеница мягкая')).toBeNull();
    expect(photoCredit(`/api/v1/public/files/${wheat.slice(0, 14)}4${wheat.slice(15)}`)).toBeNull();
    expect(photoCredit(null)).toBeNull();
  });
});
