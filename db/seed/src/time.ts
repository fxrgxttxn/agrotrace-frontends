/** Fixed "now" of the demo world: every seeded timestamp is at or before it. */
export const NOW = '2026-09-20T09:00:00Z';

const MIN = 60_000;

/** Normalizes an ISO instant to `YYYY-MM-DDTHH:MM:SSZ` (the API DateTime format). */
export function iso(t: string | number | Date): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid time: ${String(t)}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `at('2026-06-02 08:00')` → `2026-06-02T08:00:00Z` (UTC). */
export function at(s: string): string {
  return iso(`${s.replace(' ', 'T')}${s.length <= 16 ? ':00' : ''}Z`);
}

export function plusMinutes(t: string, minutes: number): string {
  return iso(Date.parse(t) + minutes * MIN);
}

export function plusSeconds(t: string, seconds: number): string {
  return iso(Date.parse(t) + seconds * 1000);
}

export const cmp = (a: string, b: string): number => Date.parse(a) - Date.parse(b);
