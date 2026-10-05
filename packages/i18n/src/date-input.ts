const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const RU_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

export function formatRuDate(iso: string | null | undefined): string {
  const m = ISO_DATE.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

export function parseRuDate(text: string): string | null {
  const m = RU_DATE.exec(text.trim());
  if (!m) return null;
  const [, d = '', mo = '', y = ''] = m;
  if (!isCalendarDate(Number(y), Number(mo), Number(d))) return null;
  return `${y}-${mo}-${d}`;
}

export function maskRuDateInput(raw: string): string {
  const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(raw);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean);
  return parts.join('.');
}

export function isWithinRuDateBounds(iso: string, min?: string | null, max?: string | null): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  if (min && iso < min) return false;
  if (max && iso > max) return false;
  return true;
}
