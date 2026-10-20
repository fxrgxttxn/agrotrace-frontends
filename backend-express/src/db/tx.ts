/**
 * Transactions (R47/R52): READ COMMITTED by default, REPEATABLE READ for the recall engine (R54/D7). A deadlock
 * (40P01) or serialization failure (40001) re-runs the whole transaction once; a second failure is 409
 * VERSION_CONFLICT (`params.currentVersion` from `conflictParams`, if the operation has an If-Match entity).
 *
 * Contract for `fn` (P8): it may run TWICE, so it touches only the database through `tx` — no Redis, no S3, no
 * publishing, no email, no in-memory state that survives a failed attempt. Side effects that must follow the commit
 * go to the outbox (`enqueue(tx, …)`) or run after `withTx` resolves (e.g. `pub:batch` cache deletion).
 */
import type { IsolationLevel, Kysely, Transaction } from 'kysely';
import { AppProblem } from '../http/problem.js';

export type TxIsolation = Extract<IsolationLevel, 'read committed' | 'repeatable read' | 'serializable'>;

export interface TxOptions {
  isolation?: TxIsolation;
  /** Retry once on 40P01/40001 (default true). */
  retryOnce?: boolean;
  /**
   * Further errors that re-run the transaction once (same budget as 40P01/40001) — e.g. the recall engine's
   * `ux_recalls_open_source` unique violation (tag Recalls, step 1): the repeat finds the recall the other one created.
   */
  retryIf?: (err: unknown) => boolean;
  /** `params` of the 409 after the retry also failed (e.g. `{currentVersion}`), read outside the failed tx. */
  conflictParams?: () => Promise<Record<string, unknown> | undefined>;
}

const RETRYABLE = new Set(['40P01', '40001']);

export const isRetryableTxError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && RETRYABLE.has((err as { code?: unknown }).code as string);

export async function withTx<DB, T>(
  db: Kysely<DB>,
  fn: (tx: Transaction<DB>) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const attempts = opts.retryOnce === false ? 1 : 2;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel(opts.isolation ?? 'read committed')
        .execute(fn);
    } catch (err) {
      if (!isRetryableTxError(err) && !opts.retryIf?.(err)) throw err;
      if (attempt < attempts) continue;
      const params = opts.conflictParams ? await opts.conflictParams() : undefined;
      throw new AppProblem(409, 'VERSION_CONFLICT', params ? { params } : {});
    }
  }
}
