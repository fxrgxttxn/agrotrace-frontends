/**
 * The story in scenario.ts is written against this moment; the seed shifts every timestamp by
 * SEED_NOW − REFERENCE_NOW (R73), so the demo world always ends "now".
 */
export const REFERENCE_NOW = '2026-09-20T09:00:00Z';

/** SEED_NOW from the environment (ISO instant), else the real clock truncated to the minute. */
export function seedNowFrom(value: string | undefined, clock = Date.now()): string {
  if (value) {
    const t = Date.parse(value);
    if (Number.isNaN(t) || !/(Z|[+-]\d\d:\d\d)$/.test(value))
      throw new RangeError(`SEED_NOW is not an ISO instant: ${value}`);
    if (t % 60_000 !== 0) throw new RangeError(`SEED_NOW must be a whole minute: ${value}`);
    return iso(t);
  }
  return iso(Math.floor(clock / 60_000) * 60_000);
}

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
