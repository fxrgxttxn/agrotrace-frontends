// Helpers for the `at-date` text input (design-system README, ruling R70): the field shows and
// accepts ДД.ММ.ГГГГ whatever the browser locale; the model value is an ISO date (YYYY-MM-DD).
// Pure functions, shared by the React, Angular and Svelte wrappers.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const RU_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** `'2026-08-14'` (or a DateTime starting with it) → `'14.08.2026'`; empty or malformed → `''`. */
export function formatRuDate(iso: string | null | undefined): string {
  const m = ISO_DATE.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** `'14.08.2026'` → `'2026-08-14'`; incomplete, differently shaped or impossible dates → `null`. */
export function parseRuDate(text: string): string | null {
  const m = RU_DATE.exec(text.trim());
  if (!m) return null;
  const [, d = '', mo = '', y = ''] = m;
  if (!isCalendarDate(Number(y), Number(mo), Number(d))) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * Masks what the user typed or pasted: keeps up to 8 digits and inserts the dots
 * (`'1408'` → `'14.08'`). A pasted ISO date is converted (`'2026-08-14'` → `'14.08.2026'`).
 * No trailing dot is added, so Backspace works naturally.
 */
export function maskRuDateInput(raw: string): string {
  const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(raw);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean);
  return parts.join('.');
}
