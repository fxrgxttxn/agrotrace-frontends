import type { Locale } from './format.js';
import { resolve, substitute } from './resolve.js';

const PLURAL_TEMPLATE = /^\{(\w+),\s*plural,\s*(.+)\}$/s;
const PLURAL_CATEGORY = /(\w+)\s*\{([^{}]*)\}/g;

function resolvePlural(template: string, count: number, locale: Locale): string {
  const match = PLURAL_TEMPLATE.exec(template);
  if (!match) return template;
  const body = match[2]!;
  const categories = new Map<string, string>();
  for (const m of body.matchAll(PLURAL_CATEGORY)) categories.set(m[1]!, m[2]!);
  const selected = new Intl.PluralRules(locale).select(count);
  const text = categories.get(selected) ?? categories.get('other') ?? '';
  return text.replace(/#/g, String(count));
}

export function makeT(dict: object, locale: Locale) {
  function t(key: string, params?: Record<string, string | number>): string {
    let template = resolve(dict, key) ?? key;
    if (params && typeof params.count === 'number' && PLURAL_TEMPLATE.test(template)) {
      template = resolvePlural(template, params.count, locale);
    }
    return substitute(template, params);
  }
  t.locale = locale;
  return t;
}
