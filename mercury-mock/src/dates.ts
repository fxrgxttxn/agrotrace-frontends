/**
 * Relative document dates (R90). `data/vsd.json` is written as of MOCK_REFERENCE_NOW — the same moment the demo
 * story of db/seed is written against (db/seed/src/time.ts REFERENCE_NOW) — and every date of a document
 * (`issueDate`, `vetInspection.date`) is served shifted by the whole UTC days between that moment and "now". So the
 * documents always lie as many days in the past as the dataset says, the demo batches (seeded relative to SEED_NOW)
 * find their VSD, and a batch harvested today finds today's documents.
 *
 * "now" is the clock at the moment of the request, or MOCK_NOW (ISO instant) when set — tests pin it. Pure module:
 * no Node APIs, so db/seed replays the very same shift.
 */

import type { Vsd } from './store.js';

export const MOCK_REFERENCE_NOW = '2026-09-20T09:00:00Z';

const DAY = 86_400_000;
const utcDay = (t: number): number => Math.floor(t / DAY);

/** Whole UTC days from MOCK_REFERENCE_NOW's date to `now`'s date (negative before it). */
export function shiftDays(now: number): number {
  return utcDay(now) - utcDay(Date.parse(MOCK_REFERENCE_NOW));
}

/** `YYYY-MM-DD` + `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** The dataset as served at `now`: every document date shifted by shiftDays(now). */
export function shiftVsdDates(list: readonly Vsd[], now: number): Vsd[] {
  const d = shiftDays(now);
  return list.map((v) => ({
    ...v,
    issueDate: addDays(v.issueDate, d),
    vetInspection: { ...v.vetInspection, date: addDays(v.vetInspection.date, d) },
  }));
}

/** MOCK_NOW (ISO instant with Z or an offset) → epoch ms; unset/empty → null; anything else throws. */
export function parseMockNow(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t) || !/T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value))
    throw new RangeError(`MOCK_NOW is not an ISO instant: ${value}`);
  return t;
}
