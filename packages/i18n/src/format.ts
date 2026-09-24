export type Locale = 'ru' | 'en';

// `Intl.NumberFormat('ru-RU')` groups thousands with a narrow no-break space
// (U+202F); the expected Russian mass format uses a plain no-break space
// (U+00A0) instead, so grouping is done by hand with U+00A0 (fixed by test)
// rather than through `Intl.NumberFormat`.
const NBSP = ' ';

function groupThousands(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Formats a mass in kilograms, e.g. `formatMass('12480.000', 'ru')` ->
 * `'12 480,000 кг'`. The input is the wire-format decimal string
 * (exactly 3 decimal places, per the contract's `PositiveMass`/`Mass`); it is
 * formatted by string manipulation, never parsed as a float, so precision is
 * never at risk.
 */
export function formatMass(kg: string, locale: Locale): string {
  const [intPart = '0', decPart = '000'] = kg.split('.');
  const groupSeparator = locale === 'ru' ? NBSP : ',';
  const decimalSeparator = locale === 'ru' ? ',' : '.';
  const unit = locale === 'ru' ? 'кг' : 'kg';
  return `${groupThousands(intPart, groupSeparator)}${decimalSeparator}${decPart} ${unit}`;
}

function splitDateParts(iso: string): { y: string; m: string; d: string } {
  const y = iso.slice(0, 4);
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  return { y, m, d };
}

/** Formats a calendar date (accepts a `Date` or `DateTime` ISO string). `formatDate('2026-09-25', 'ru')` -> `'25.09.2026'`. */
export function formatDate(iso: string, locale: Locale): string {
  const { y, m, d } = splitDateParts(iso);
  return locale === 'ru' ? `${d}.${m}.${y}` : `${m}/${d}/${y}`;
}

/** Formats an instant (`DateTime` ISO string, UTC) as a date and 24-hour time. */
export function formatDateTime(iso: string, locale: Locale): string {
  const time = iso.slice(11, 16);
  return `${formatDate(iso, locale)} ${time}`;
}

/** Formats a `Percent`/decimal string with locale decimal separator, e.g. `'2.50'` -> `'2,50%'` (ru) / `'2.50%'` (en). */
export function formatPercent(value: string, locale: Locale): string {
  const decimalSeparator = locale === 'ru' ? ',' : '.';
  return `${value.replace('.', decimalSeparator)}%`;
}
