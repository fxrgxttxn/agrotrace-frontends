import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

export type { Locale } from './format.js';
export { formatMass, formatDate, formatDateTime, formatPercent } from './format.js';
export { formatRuDate, parseRuDate, maskRuDateInput, isWithinRuDateBounds } from './date-input.js';
export { problemMessage, type Problem } from './problem.js';

export type Dictionary = typeof ru;

const DICTIONARIES: Record<'ru' | 'en', Dictionary> = { ru, en };

type Json = Record<string, unknown> | string;

/**
 * Resolves a dotted key such as `validation.email.taken` or
 * `status.batch.Created`. Namespaces that store flat i18n keys (currently
 * `validation`, whose keys mirror the contract's dotted `validation.*` error
 * codes literally, including the dots) are tried first; namespaces that
 * nest by level (`status.<enum>.<Value>`, `rules.BR-01`, `errors.<CODE>`)
 * fall back to walking the remaining segments one at a time.
 */
function resolve(dict: Dictionary, key: string): string | undefined {
  const dot = key.indexOf('.');
  if (dot === -1) {
    const value = (dict as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  const namespace = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const node = (dict as Record<string, unknown>)[namespace];
  if (node == null || typeof node !== 'object') return undefined;

  const flat = (node as Record<string, unknown>)[rest];
  if (typeof flat === 'string') return flat;

  let cursor: Json = node as Json;
  for (const segment of rest.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment] as Json;
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

const PLURAL_TEMPLATE = /^\{(\w+),\s*plural,\s*(.+)\}$/s;
const PLURAL_CATEGORY = /(\w+)\s*\{([^{}]*)\}/g;

function resolvePlural(template: string, count: number, locale: 'ru' | 'en'): string {
  const match = PLURAL_TEMPLATE.exec(template);
  if (!match) return template;
  const body = match[2]!;
  const categories = new Map<string, string>();
  for (const m of body.matchAll(PLURAL_CATEGORY)) categories.set(m[1]!, m[2]!);
  const selected = new Intl.PluralRules(locale).select(count);
  const text = categories.get(selected) ?? categories.get('other') ?? '';
  return text.replace(/#/g, String(count));
}

/**
 * `createT(locale)` returns a translation function supporting `{name}`
 * substitution and ICU-lite pluralization
 * (`{count, plural, one {…} few {…} many {…} other {…}}`, via
 * `Intl.PluralRules`). Missing keys resolve to the key itself.
 */
export function createT(locale: 'ru' | 'en') {
  const dict = DICTIONARIES[locale];
  function t(key: string, params?: Record<string, string | number>): string {
    let template = resolve(dict, key) ?? key;
    if (params && typeof params.count === 'number' && PLURAL_TEMPLATE.test(template)) {
      template = resolvePlural(template, params.count, locale);
    }
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        template = template.replaceAll(`{${name}}`, String(value));
      }
    }
    return template;
  }
  t.locale = locale;
  return t;
}
