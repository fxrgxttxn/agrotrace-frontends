import { formatDate, type Locale } from './format.js';

export interface Problem {
  code: string;
  rule?: string;
  params?: Record<string, unknown>;
}

type T = ((key: string, params?: Record<string, string | number>) => string) & { locale?: Locale };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Date-/datetime-shaped params are formatted for the resolved `t`'s locale before substitution. */
function displayParams(
  params: Record<string, unknown> | undefined,
  locale: Locale,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' && ISO_DATE.test(value)) out[key] = formatDate(value, locale);
    else if (typeof value === 'string' || typeof value === 'number') out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

/**
 * Resolves a `Problem`-shaped error to display text: `rules.<rule>` for a
 * 422 `BUSINESS_RULE` with a known rule (its `params` substituted, with
 * date-shaped values formatted first), otherwise `errors.<code>`, falling
 * back to `errors.UNKNOWN` when neither key is translated.
 */
export function problemMessage(p: Problem, t: T): string {
  const locale = t.locale ?? 'ru';
  if (p.rule) {
    const key = `rules.${p.rule}`;
    const message = t(key, displayParams(p.params, locale));
    if (message !== key) return message;
  }
  const errorKey = `errors.${p.code}`;
  const message = t(errorKey);
  return message === errorKey ? t('errors.UNKNOWN') : message;
}
