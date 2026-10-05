import { formatDate, formatMass, formatPercent, type Locale } from './format.js';

export interface Problem {
  code: string;
  rule?: string;
  params?: Record<string, unknown>;
}

export type T = ((key: string, params?: Record<string, string | number>) => string) & { locale?: Locale };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const MASS = /^\d+\.\d{3}$/;

function displayParams(
  params: Record<string, unknown> | undefined,
  t: T,
  locale: Locale,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' && key === 'status') {
      const label = t(`status.batch.${value}`);
      out[key] = label === `status.batch.${value}` ? value : label;
    } else if (typeof value === 'string' && key.endsWith('Kg') && MASS.test(value))
      out[key] = formatMass(value, locale);
    else if (typeof value === 'string' && key === 'percent') out[key] = formatPercent(value, locale);
    else if (typeof value === 'string' && ISO_DATE.test(value)) out[key] = formatDate(value, locale);
    else if (typeof value === 'string' || typeof value === 'number') out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

export function problemMessage(p: Problem, t: T): string {
  const locale = t.locale ?? 'ru';
  if (p.rule) {
    const key = `rules.${p.rule}`;
    const message = t(key, displayParams(p.params, t, locale));
    if (message !== key) return message;
  }
  const errorKey = `errors.${p.code}`;
  const message = t(errorKey);
  return message === errorKey ? t('errors.UNKNOWN') : message;
}
