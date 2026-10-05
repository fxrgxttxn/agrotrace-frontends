import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };
import { makeT } from './translate.js';

export type { Locale } from './format.js';
export {
  formatMass,
  formatDate,
  formatDateTime,
  formatPercent,
  formatLocalDateTime,
  formatLocalTime,
  formatBytes,
  formatDecimal,
  formatLocalDate,
} from './format.js';
export { formatRuDate, parseRuDate, maskRuDateInput, isWithinRuDateBounds } from './date-input.js';
export { problemMessage, type Problem, type T } from './problem.js';
export { ENUM_LABELS, enumLabel } from './enum-labels.js';
export { notificationMessage, NOTIFICATION_PARAM_LABELS, type NotificationPart } from './notification.js';
export { auditActionLabel, auditFieldLabel, auditValue, type AuditValueContext } from './audit.js';

export type Dictionary = typeof ru;

const DICTIONARIES: Record<'ru' | 'en', Dictionary> = { ru, en };

export function createT(locale: 'ru' | 'en') {
  return makeT(DICTIONARIES[locale], locale);
}
