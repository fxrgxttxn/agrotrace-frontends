/**
 * Row locks of the protocol R47/R52 (contract info.description): one total order for every operation —
 * `waybill` → `recall` → `labTest` → `complaint` → `organization` → `batches` (all affected batches in ONE
 * `SELECT … FOR NO KEY UPDATE … ORDER BY id`) → `recallTasks` (`ORDER BY id`) → other rows (`batchDocument`, …). An operation
 * skips what it does not need but never changes the order. Every check from 404 on runs over the locked rows; the
 * order of items in an operation (e.g. by publicCode) only decides which error comes first.
 */
import type { Transaction } from 'kysely';
import type { DB } from './types.generated.js';

type Tx = Transaction<DB>;

/** The waybill row `FOR NO KEY UPDATE` (deleted ones included — visibility is the caller's check). */
export function lockWaybill(tx: Tx, id: string) {
  return tx.selectFrom('waybills').selectAll().where('id', '=', id).forNoKeyUpdate().executeTakeFirst();
}

/** The batches `FOR NO KEY UPDATE ORDER BY id`, one statement; missing ids are simply absent. */
export async function lockBatches(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .selectFrom('batches')
    .selectAll()
    .where('id', 'in', [...new Set(ids)])
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
}

/** Recall tasks `FOR NO KEY UPDATE ORDER BY id` (after the batches). */
export async function lockRecallTasks(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .selectFrom('recall_tasks')
    .selectAll()
    .where('id', 'in', [...new Set(ids)])
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
}
