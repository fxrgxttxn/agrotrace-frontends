import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import {
  createT,
  ENUM_LABELS,
  enumLabel,
  notificationMessage,
  problemMessage,
  type NotificationPart,
} from '../src/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../contracts/redocly.yaml', import.meta.url));
const RULES = JSON.parse(
  readFileSync(new URL('../../../contracts/rules/notifications.json', import.meta.url), 'utf8'),
) as { types: Record<string, { payload: string[]; producedBy: string[] }> };

const TECHNICAL: Record<string, string> = {
  HealthCheckStatus: 'health probe payload for monitoring',
  'AltchaChallenge.algorithm': 'captcha protocol constant',
  'param:variant': 'image size variant (96/480 px) of a file URL',
  'param:format': 'QR file format code (png/pdf), shown as the file extension',
};

let doc: Json;
let enums: Map<string, string[]>;

const deref = (node: Json): Json => {
  let cur = node;
  while (cur && typeof cur.$ref === 'string')
    cur = cur.$ref
      .slice(2)
      .split('/')
      .reduce((acc: Json, k: string) => acc?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  return cur;
};

function collectEnums(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (where: string, values: unknown[]) =>
    out.set(where, [
      ...new Set([...(out.get(where) ?? []), ...values.filter((v): v is string => v !== null)]),
    ]);
  const walk = (s: Json | undefined, where: string): void => {
    if (!s || typeof s !== 'object' || '$ref' in s) return;
    if (Array.isArray(s.enum)) add(where, s.enum);
    for (const [p, sub] of Object.entries<Json>(s.properties ?? {})) walk(sub, `${where}.${p}`);
    if (s.items) walk(s.items, where);
    for (const k of ['oneOf', 'anyOf', 'allOf']) for (const x of s[k] ?? []) walk(x, where);
  };
  for (const [name, s] of Object.entries<Json>(doc.components.schemas)) walk(s, name);
  for (const item of Object.values<Json>(doc.paths))
    for (const op of Object.values<Json>(item))
      for (const p of (op?.parameters ?? []).map(deref)) walk(p.schema, `param:${p.name}`);
  return out;
}

const labelKey = (ns: string, value: string): string =>
  ns.includes('{value}') ? ns.replace('{value}', value) : `${ns}.${value}`;

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

beforeAll(async () => {
  const config = await loadConfig({ configPath: CONFIG });
  doc = (await bundle({ ref: ROOT, config })).bundle.parsed as Json;
  enums = collectEnums();
});

describe('contract enums have labels in both locales (R87)', () => {
  it('found the contract enums (fixture sanity)', () => {
    expect(enums.size).toBeGreaterThan(40);
    expect(enums.get('ProblemCode')?.length).toBeGreaterThanOrEqual(25);
  });

  it('every enum is either labelled or explicitly technical, and neither table has stale entries', () => {
    const found = [...enums.keys()].sort();
    expect(found.filter((k) => !(k in ENUM_LABELS) && !(k in TECHNICAL))).toEqual([]);
    expect(Object.keys(ENUM_LABELS).filter((k) => !enums.has(k))).toEqual([]);
    expect(Object.keys(TECHNICAL).filter((k) => !enums.has(k))).toEqual([]);
  });

  for (const locale of ['ru', 'en'] as const) {
    it(`${locale}: every value of every labelled enum is translated (ProblemCode → errors.<code> included)`, () => {
      const t = createT(locale);
      const missing: string[] = [];
      for (const [where, ns] of Object.entries(ENUM_LABELS))
        for (const value of enums.get(where) ?? []) {
          const key = labelKey(ns, value);
          if (t(key) === key) missing.push(`${where}: ${key}`);
        }
      expect(missing).toEqual([]);
    });
  }
});

describe('enumLabel', () => {
  it('resolves through ENUM_LABELS, falls back to the value', () => {
    const ru = createT('ru');
    expect(enumLabel(ru, 'BatchStatus', 'OnTest')).toBe('На анализе');
    expect(enumLabel(ru, 'NotificationType', 'RECALL')).toBe('Отзыв');
    expect(enumLabel(createT('en'), 'param:direction', 'incoming')).toBe('Incoming');
    expect(enumLabel(ru, 'BatchStatus', 'Lost')).toBe('Lost');
    expect(enumLabel(ru, 'NoSuchEnum', 'X')).toBe('X');
  });
});

describe('rule messages use every param of their 422 problem (R87)', () => {
  const ruleParams = (): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const item of Object.values<Json>(doc.paths))
      for (const op of Object.values<Json>(item)) {
        const media = deref(op?.responses?.['422'] ?? {}).content?.['application/problem+json'] ?? {};
        const examples = [
          ...('example' in media ? [media.example] : []),
          ...Object.values<Json>(media.examples ?? {}).map((e) => deref(e).value),
        ];
        for (const e of examples)
          if (e?.rule) out.set(e.rule, new Set([...(out.get(e.rule) ?? []), ...Object.keys(e.params ?? {})]));
      }
    return out;
  };

  it('found the rules of the contract (fixture sanity)', () => {
    expect([...ruleParams().keys()].sort()).toEqual(['BR-01', 'BR-04', 'BR-05', 'BR-06', 'BR-07']);
  });

  for (const locale of ['ru', 'en'] as const) {
    it(`${locale}: rules.<rule> has a placeholder for every param and no other`, () => {
      const dict = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
      const bad: string[] = [];
      for (const [rule, params] of ruleParams()) {
        const template: string = dict.rules[rule] ?? '';
        const used = new Set(placeholders(template));
        for (const p of params) if (!used.has(p)) bad.push(`${rule}: {${p}} missing`);
        for (const p of used) if (!params.has(p)) bad.push(`${rule}: {${p}} is not a param`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('problemMessage renders params in display form (status label, masses, percent, date)', () => {
    const ru = createT('ru');
    expect(
      problemMessage(
        {
          code: 'BUSINESS_RULE',
          rule: 'BR-06',
          params: { publicCode: 'AT-2026-000125', status: 'Recalled' },
        },
        ru,
      ),
    ).toBe('Партия AT-2026-000125 в статусе «Отозвана» недоступна для этой операции');
    expect(
      problemMessage(
        {
          code: 'BUSINESS_RULE',
          rule: 'BR-04',
          params: { inputKg: '12190.000', allowedKg: '12007.150', outputKg: '12100.000' },
        },
        ru,
      ),
    ).toBe(
      'Выход переработки 12 100,000 кг больше допустимого 12 007,150 кг: вход 12 190,000 кг за вычетом нормы потерь'.replace(
        /(\d) (\d)/g,
        '$1 $2',
      ),
    );
    expect(
      problemMessage(
        { code: 'BUSINESS_RULE', rule: 'BR-07', params: { publicCode: 'AT-2026-000123', percent: '2.32' } },
        createT('en'),
      ),
    ).toBe('Mass discrepancy of batch AT-2026-000123 is 2.32%: a discrepancy over 2% requires a report');
    expect(
      problemMessage(
        {
          code: 'BUSINESS_RULE',
          rule: 'BR-01',
          params: { publicCode: 'AT-2026-000123', until: '2026-09-25', substance: 'Хлорпирифос' },
        },
        ru,
      ),
    ).toBe(
      'Партию AT-2026-000123 можно отгрузить с 25.09.2026: не истёк срок ожидания препарата Хлорпирифос',
    );
  });
});

describe('notification templates (R87)', () => {
  const PARTS: NotificationPart[] = ['title', 'body', 'email.subject', 'email.body', 'telegram'];
  const eventsOf = (type: string): string[] => [
    ...new Set(
      RULES.types[type]!.producedBy.flatMap((p) => [...p.matchAll(/\(event (\w+)/g)].map((m) => m[1]!)),
    ),
  ];

  it('knows the event variants of RECALL and RECALL_TASK (fixture sanity)', () => {
    expect(eventsOf('RECALL')).toEqual(['OPENED', 'CLOSED']);
    expect(eventsOf('RECALL_TASK')).toEqual(['CREATED', 'REASSIGNED']);
    expect(eventsOf('LAB_RESULT')).toEqual([]);
  });

  for (const locale of ['ru', 'en'] as const) {
    it(`${locale}: every type (and event) has title, body, email subject/body and telegram, using only payload keys`, () => {
      const dict = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
      const bad: string[] = [];
      for (const [type, rule] of Object.entries(RULES.types)) {
        const keys = new Set(rule.payload.filter((k) => k !== 'event'));
        const node = dict.notification?.[type];
        if (typeof node?.label !== 'string') bad.push(`${type}: label`);
        const variants = eventsOf(type);
        if (variants.length && !rule.payload.includes('event'))
          bad.push(`${type}: events without payload.event`);
        for (const [name, v] of variants.length ? variants.map((e) => [e, node?.[e]]) : [['', node]]) {
          for (const part of PARTS) {
            const text = part.split('.').reduce((acc: Json | undefined, k) => acc?.[k], v);
            const where = `${type}${name ? `.${name}` : ''}.${part}`;
            if (typeof text !== 'string' || !text.trim()) {
              bad.push(`${where}: missing`);
              continue;
            }
            for (const p of placeholders(text))
              if (!keys.has(p)) bad.push(`${where}: {${p}} is not a payload key`);
            const id = keys.has('publicCode') ? 'publicCode' : 'number';
            if (part !== 'title' && part !== 'email.subject' && !text.includes(`{${id}}`))
              bad.push(`${where}: must name the object ({${id}})`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('notificationMessage fills every placeholder, with labels for codes and formatted instants', () => {
    const ru = createT('ru');
    const sample = (type: string, event?: string): Record<string, unknown> =>
      Object.fromEntries(
        RULES.types[type]!.payload.map((k) => [
          k,
          k === 'event'
            ? event
            : k === 'reason'
              ? 'RISK'
              : k === 'conclusion'
                ? 'FAIL'
                : k === 'trigger'
                  ? 'LAB'
                  : k.endsWith('At')
                    ? '2026-09-25T09:30:00Z'
                    : k === 'itemsCount'
                      ? 2
                      : `<${k}>`,
        ]),
      );
    const leftovers: string[] = [];
    for (const type of Object.keys(RULES.types)) {
      const variants = eventsOf(type);
      for (const event of variants.length ? variants : [undefined])
        for (const part of PARTS) {
          const text = notificationMessage(type, sample(type, event), part, ru);
          if (/\{\w+\}|^notification\./.test(text)) leftovers.push(`${type} ${event ?? ''} ${part}: ${text}`);
        }
    }
    expect(leftovers).toEqual([]);
    expect(notificationMessage('LAB_RESULT', sample('LAB_RESULT'), 'body', ru)).toBe(
      '<productName>, партия <publicCode>: Превышение нормативов',
    );
    expect(notificationMessage('RECALL_TASK', sample('RECALL_TASK', 'CREATED'), 'telegram', ru)).toBe(
      'Изъять партию <publicCode> до 25.09.2026 09:30',
    );
  });
});

describe('notification templates are plain text (R92: no emoji)', () => {
  const EMOJI =
    /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  const locales = {
    ru: JSON.parse(readFileSync(new URL('../locales/ru.json', import.meta.url), 'utf8')),
    en: JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')),
  };
  for (const [name, dict] of Object.entries(locales)) {
    it(`${name}: no emoji in any notification template`, () => {
      const bad: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (typeof v === 'string') {
          if (EMOJI.test(v)) bad.push(`${path}: ${v}`);
        } else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      walk((dict as Record<string, unknown>).notification, 'notification');
      expect(bad).toEqual([]);
    });
  }
});
