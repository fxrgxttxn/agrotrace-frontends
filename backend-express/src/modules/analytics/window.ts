/**
 * The analytics window (getDashboard, downloadReport; contracts/openapi/paths/analytics.yaml, reports.yaml): UTC dates,
 * inclusive. Default — the last 30 days: `to` = today (UTC, the snapshot transaction's clock), `from` = `to` − 29; one
 * end given — the other one 29 days from it; `from` > `to` → `errors.from: [validation.range]` (QueryReader); longer
 * than 366 days → `errors.from: [validation.range.tooLong]`. And the read-only snapshot all analytics run in: one
 * transaction READ ONLY REPEATABLE READ.
 */
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db/db.js';
import type { DB } from '../../db/types.generated.js';

export interface Window {
  from: string;
  to: string;
}

const DAY = 86_400_000;
const FIRST = Date.parse('0000-01-01T00:00:00Z');
const LAST = Date.parse('9999-12-31T00:00:00Z');
/** `date` ± `days`, held to 0000-01-01 … 9999-12-31 (PL12: period labels and file names stay `YYYY-MM-DD`, as on the
 * other backends — never `+010000-01-28`). */
const shift = (date: string, days: number): string =>
  new Date(Math.min(LAST, Math.max(FIRST, Date.parse(`${date}T00:00:00Z`) + days * DAY))).toISOString().slice(0, 10);

/** True when explicit bounds span more than 366 days (a default or one-sided window never does). */
export const tooLong = (from: string | undefined, to: string | undefined): boolean =>
  from !== undefined && to !== undefined && (Date.parse(to) - Date.parse(from)) / DAY + 1 > 366;

/** The applied window; `today` = the UTC date of the snapshot's now(). */
export function resolveWindow(from: string | undefined, to: string | undefined, today: string): Window {
  if (from === undefined && to === undefined) return { from: shift(today, -29), to: today };
  if (from === undefined) return { from: shift(to!, -29), to: to! };
  if (to === undefined) return { from, to: shift(from, 29) };
  return { from, to };
}

/** Half-open instant bounds of a window: [from 00:00Z, to + 1 day 00:00Z). */
export const bounds = (w: Window): { start: Date; end: Date } => ({
  start: new Date(`${w.from}T00:00:00Z`),
  end: new Date(Date.parse(`${w.to}T00:00:00Z`) + DAY),
});

/** Runs `fn` in one READ ONLY REPEATABLE READ transaction with the snapshot's now() (P43: one instant). */
export function snapshot<T>(db: Db, fn: (tx: Transaction<DB>, now: Date) => Promise<T>): Promise<T> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const r = await sql<{ now: Date }>`SELECT now() AS now`.execute(tx);
      return fn(tx, r.rows[0]!.now);
    });
}
