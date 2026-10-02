import type { Locale } from './format.js';

// Instants in the viewer's time zone (split from format.ts so the public page can import them alone, FM35).

function localParts(iso: string, timeZone?: string): Record<string, string> | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/**
 * An instant (`DateTime`, UTC) in the viewer's time zone (or `timeZone`) as a date and 24-hour time — for moments
 * the person acts on: when a lock ends, until when a code is valid, when a notification arrived. An unparsable value
 * is returned as it is.
 */
export function formatLocalDateTime(iso: string, locale: Locale, timeZone?: string): string {
  const p = localParts(iso, timeZone);
  if (!p) return iso;
  const date = locale === 'ru' ? `${p.day}.${p.month}.${p.year}` : `${p.month}/${p.day}/${p.year}`;
  return `${date} ${p.hour}:${p.minute}`;
}

/** Only the 24-hour time of `formatLocalDateTime`. */
export function formatLocalTime(iso: string, locale: Locale, timeZone?: string): string {
  void locale;
  const p = localParts(iso, timeZone);
  return p ? `${p.hour}:${p.minute}` : iso;
}

/** Only the date of `formatLocalDateTime` (the viewer's calendar day of an instant). */
export function formatLocalDate(iso: string, locale: Locale, timeZone?: string): string {
  const p = localParts(iso, timeZone);
  if (!p) return iso;
  return locale === 'ru' ? `${p.day}.${p.month}.${p.year}` : `${p.month}/${p.day}/${p.year}`;
}
