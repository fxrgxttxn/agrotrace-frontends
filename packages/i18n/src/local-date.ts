import type { Locale } from './format.js';

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

export function formatLocalDateTime(iso: string, locale: Locale, timeZone?: string): string {
  const p = localParts(iso, timeZone);
  if (!p) return iso;
  const date = locale === 'ru' ? `${p.day}.${p.month}.${p.year}` : `${p.month}/${p.day}/${p.year}`;
  return `${date} ${p.hour}:${p.minute}`;
}

export function formatLocalTime(iso: string, locale: Locale, timeZone?: string): string {
  void locale;
  const p = localParts(iso, timeZone);
  return p ? `${p.hour}:${p.minute}` : iso;
}

export function formatLocalDate(iso: string, locale: Locale, timeZone?: string): string {
  const p = localParts(iso, timeZone);
  if (!p) return iso;
  return locale === 'ru' ? `${p.day}.${p.month}.${p.year}` : `${p.month}/${p.day}/${p.year}`;
}
