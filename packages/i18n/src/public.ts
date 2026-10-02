import type { Locale } from './format.js';
import { resolve, substitute } from './resolve.js';

/**
 * `@agrotrace/i18n/public` — the i18n of the public QR page (ruling FM35). The page must stay within its JS budget
 * (≤ 60 KB gzip, spec §9.6), so it never imports `@agrotrace/i18n` (both full dictionaries): it imports this module
 * plus the subset dictionary of the active locale only, `@agrotrace/i18n/public/<locale>.json` (the keys listed in
 * `public-keys.ts`), and builds its `t` with {@link publicT}:
 *
 * ```ts
 * import ru from '@agrotrace/i18n/public/ru.json';
 * import { publicT } from '@agrotrace/i18n/public';
 * export const t = publicT(ru, 'ru');
 * ```
 *
 * Angular and Svelte do the same in their public entry. The texts equal those of `createT` for the same keys (test).
 */
export function publicT(dict: object, locale: Locale) {
  const t = (key: string, params?: Record<string, string | number>) =>
    substitute(resolve(dict, key) ?? key, params);
  return Object.assign(t, { locale });
}

export type { Locale } from './format.js';
export { formatLocalDate, formatLocalDateTime } from './local-date.js';
export { problemMessage, type Problem, type T } from './problem.js';
export { enumLabel } from './enum-labels.js';
export { photoCredit, type PhotoCredit } from './photo-credits.js';
