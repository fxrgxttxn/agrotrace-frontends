import type { Locale } from './format.js';
import { resolve, substitute } from './resolve.js';

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
