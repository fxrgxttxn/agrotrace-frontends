import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };
import {
  createT,
  formatMass,
  formatDate,
  formatDateTime,
  formatPercent,
  problemMessage,
} from '../src/index.js';

type Dict = Record<string, unknown>;

/** Flattens a dictionary to dotted keys. A namespace's own keys may themselves contain dots (e.g. `validation`'s `email.taken`) — they are still leaves, not further nested. */
function flatten(node: unknown, prefix: string, out: string[]): string[] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Dict)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

const RU_KEYS = flatten(ru, '', []).sort();
const EN_KEYS = flatten(en, '', []).sort();

// Ruling R5 (+ R42, R48, R54 REFERENCE_IN_USE) — exact ProblemCode enum from the contract.
const PROBLEM_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'BUSINESS_RULE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'TWO_FACTOR_REQUIRED',
  'INVALID_TWO_FACTOR_CODE',
  'TOKEN_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_IDEMPOTENCY_KEY',
  'CAPTCHA_FAILED',
  'GRAPH_CYCLE',
  'BACKEND_UNAVAILABLE',
  'EXTERNAL_UNAVAILABLE',
  'INTERNAL',
  'NO_LAB_AVAILABLE',
  'IDEMPOTENCY_KEY_IN_PROGRESS',
  'REFERENCE_IN_USE',
];

const BR_RULES = Array.from({ length: 11 }, (_, i) => `BR-${String(i + 1).padStart(2, '0')}`);

const VALIDATION_SRC = fileURLToPath(new URL('../../validation/src', import.meta.url));
const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts', import.meta.url));
const VALIDATION_KEY = /validation\.[a-zA-Z][a-zA-Z0-9.]*/g;

/** Every `.ts` file directly under a directory (non-recursive; matches the flat `src/*.ts` layout of @agrotrace/validation). */
function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f}`);
}

/** All `.yaml` files under a directory, recursively (the OpenAPI contract sources). */
function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...yamlFiles(full));
    else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) out.push(full);
  }
  return out;
}

function collectValidationKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(VALIDATION_KEY)) keys.add(m[0]);
  }
  return keys;
}

const VALIDATION_KEYS_IN_PACKAGE = collectValidationKeys(tsFiles(VALIDATION_SRC));
const VALIDATION_KEYS_IN_CONTRACT = collectValidationKeys(yamlFiles(CONTRACTS_DIR));
const ALL_VALIDATION_KEYS = new Set([...VALIDATION_KEYS_IN_PACKAGE, ...VALIDATION_KEYS_IN_CONTRACT]);

describe('ru/en key parity', () => {
  it('the same set of keys exists in both locales', () => {
    expect(RU_KEYS).toEqual(EN_KEYS);
  });
  it('collected a non-trivial number of keys (fixture sanity)', () => {
    expect(RU_KEYS.length).toBeGreaterThan(100);
  });
});

describe('every ProblemCode is translated', () => {
  it(`found ${PROBLEM_CODES.length} problem codes to check (fixture sanity)`, () => {
    expect(PROBLEM_CODES.length).toBe(25);
  });
  for (const code of PROBLEM_CODES) {
    it(`errors.${code}`, () => {
      expect(RU_KEYS).toContain(`errors.${code}`);
      expect(EN_KEYS).toContain(`errors.${code}`);
    });
  }
  it('errors.UNKNOWN (fallback) is translated', () => {
    expect(RU_KEYS).toContain('errors.UNKNOWN');
    expect(EN_KEYS).toContain('errors.UNKNOWN');
  });
});

describe('every BR-01..BR-11 rule is translated', () => {
  for (const br of BR_RULES) {
    it(`rules.${br}`, () => {
      expect(RU_KEYS).toContain(`rules.${br}`);
      expect(EN_KEYS).toContain(`rules.${br}`);
    });
  }
});

describe('every validation.* key from @agrotrace/validation and from the contract is translated', () => {
  it('collected at least one key from each source (fixture sanity)', () => {
    expect(VALIDATION_KEYS_IN_PACKAGE.size).toBeGreaterThan(10);
    expect(VALIDATION_KEYS_IN_CONTRACT.size).toBeGreaterThan(10);
  });

  it('no gaps in either locale', () => {
    const missingRu = [...ALL_VALIDATION_KEYS].filter((k) => !RU_KEYS.includes(k));
    const missingEn = [...ALL_VALIDATION_KEYS].filter((k) => !EN_KEYS.includes(k));
    expect({ missingRu, missingEn }).toEqual({ missingRu: [], missingEn: [] });
  });
});

describe('copy rules: no subtitle/description/hint under nav or page', () => {
  const FORBIDDEN_SUFFIXES = ['subtitle', 'description', 'hint'];
  for (const [localeName, dict] of [
    ['ru', ru],
    ['en', en],
  ] as const) {
    it(`${localeName}: nav has no subtitle/description/hint keys`, () => {
      const keys = flatten((dict as Dict).nav, 'nav', []);
      const offenders = keys.filter((k) => FORBIDDEN_SUFFIXES.some((s) => k.endsWith(`.${s}`)));
      expect(offenders).toEqual([]);
    });
    it(`${localeName}: page (if present) has no subtitle/description/hint keys`, () => {
      const pageDict = (dict as Dict).page;
      if (pageDict === undefined) return;
      const keys = flatten(pageDict, 'page', []);
      const offenders = keys.filter((k) => FORBIDDEN_SUFFIXES.some((s) => k.endsWith(`.${s}`)));
      expect(offenders).toEqual([]);
    });
  }
});

describe('formatMass', () => {
  it("formatMass('12480.000', 'ru') uses a plain NBSP (U+00A0) group separator", () => {
    const result = formatMass('12480.000', 'ru');
    expect(result).toBe('12 480,000 кг');
    expect(result).not.toContain(' ');
  });
  it("formatMass('12480.000', 'en')", () => {
    expect(formatMass('12480.000', 'en')).toBe('12,480.000 kg');
  });
  it('formats a mass under 1000 with no group separator', () => {
    expect(formatMass('7.000', 'ru')).toBe('7,000 кг');
  });
});

describe('formatDate / formatDateTime / formatPercent', () => {
  it("formatDate('2026-09-25', 'ru') -> '25.09.2026'", () => {
    expect(formatDate('2026-09-25', 'ru')).toBe('25.09.2026');
  });
  it('formatDate accepts a full DateTime string', () => {
    expect(formatDate('2026-08-14T06:00:00Z', 'ru')).toBe('14.08.2026');
  });
  it('formatDateTime includes the 24-hour time', () => {
    expect(formatDateTime('2026-08-14T06:30:00Z', 'ru')).toBe('14.08.2026 06:30');
  });
  it("formatPercent('2.50', 'ru') -> '2,50%'", () => {
    expect(formatPercent('2.50', 'ru')).toBe('2,50%');
  });
  it("formatPercent('2.50', 'en') -> '2.50%'", () => {
    expect(formatPercent('2.50', 'en')).toBe('2.50%');
  });
});

describe('problemMessage', () => {
  const t = createT('ru');

  it('BR-01 with params, date formatted', () => {
    const message = problemMessage(
      { code: 'BUSINESS_RULE', rule: 'BR-01', params: { until: '2026-09-25', substance: 'Хлорпирифос' } },
      t,
    );
    expect(message).toBe('Отгрузка возможна после 25.09.2026: срок ожидания препарата Хлорпирифос');
  });

  it('falls back to errors.<code> when there is no rule', () => {
    expect(problemMessage({ code: 'NOT_FOUND' }, t)).toBe(t('errors.NOT_FOUND'));
  });

  it('falls back to errors.UNKNOWN for an unrecognized code', () => {
    expect(problemMessage({ code: 'SOMETHING_NEW_AND_UNTRANSLATED' }, t)).toBe(t('errors.UNKNOWN'));
  });

  it('works with the English locale too', () => {
    const tEn = createT('en');
    const message = problemMessage(
      { code: 'BUSINESS_RULE', rule: 'BR-01', params: { until: '2026-09-25', substance: 'Chlorpyrifos' } },
      tEn,
    );
    expect(message).toBe(
      'Shipping is possible after 09/25/2026: the waiting period for Chlorpyrifos has not elapsed',
    );
  });
});

describe('pluralization (Intl.PluralRules, ru)', () => {
  const t = createT('ru');
  const cases: [number, string][] = [
    [1, '1 партия'],
    [3, '3 партии'],
    [5, '5 партий'],
    [21, '21 партия'],
  ];
  for (const [count, expected] of cases) {
    it(`count.batches(${count}) -> '${expected}'`, () => {
      expect(t('count.batches', { count })).toBe(expected);
    });
  }
});

describe('createT: {name} substitution and missing-key fallback', () => {
  it('substitutes named params outside of pluralization', () => {
    const t = createT('en');
    expect(t('errors.VALIDATION')).toBe('Check the highlighted fields');
  });
  it('resolves a nested status key', () => {
    const t = createT('ru');
    expect(t('status.batch.Approved')).toBe('Допущена');
  });
  it('resolves a flat validation.* key with an embedded dot', () => {
    const t = createT('ru');
    expect(t('validation.inn.taken')).toBe('ИНН уже зарегистрирован');
  });
  it('a missing key resolves to the key itself', () => {
    const t = createT('ru');
    expect(t('nav.doesNotExist')).toBe('nav.doesNotExist');
  });
});
