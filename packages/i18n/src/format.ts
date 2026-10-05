export type Locale = 'ru' | 'en';

const NBSP = ' ';

function groupThousands(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

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

export function formatDate(iso: string, locale: Locale): string {
  const { y, m, d } = splitDateParts(iso);
  return locale === 'ru' ? `${d}.${m}.${y}` : `${m}/${d}/${y}`;
}

export function formatDateTime(iso: string, locale: Locale): string {
  const time = iso.slice(11, 16);
  return `${formatDate(iso, locale)} ${time}`;
}

export function formatPercent(value: string, locale: Locale): string {
  const decimalSeparator = locale === 'ru' ? ',' : '.';
  return `${value.replace('.', decimalSeparator)}%`;
}
export function formatBytes(bytes: number, locale: Locale): string {
  const units = locale === 'ru' ? ['Б', 'КБ', 'МБ'] : ['B', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${locale === 'ru' ? rounded.replace('.', ',') : rounded} ${units[unit]}`;
}

export function formatDecimal(value: string, locale: Locale): string {
  const [intPart = '0', decPart] = value.split('.');
  const grouped = groupThousands(intPart, locale === 'ru' ? NBSP : ',');
  return decPart === undefined ? grouped : `${grouped}${locale === 'ru' ? ',' : '.'}${decPart}`;
}

export { formatLocalDateTime, formatLocalTime, formatLocalDate } from './local-date.js';
