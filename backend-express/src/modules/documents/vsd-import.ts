/**
 * The `vsd.import` handler (R81, contracts/events/vsd.import.schema.json; worker process):
 *
 * 1. The event already claimed (`processed_events`) or the row no longer PENDING — nothing to do (a row other than
 *    PENDING still gets the claim, in an otherwise empty transaction).
 * 2. The query from the batch: productCode = products.mercury_code (NULL → NOT_FOUND without calling Mercury),
 *    senderInn = the origin organization's INN, dateFrom/dateTo = UTC dates of harvested_at ∓ 3 days.
 * 3. Up to 6 calls: a failed call records attempts + 1 and last_error in its own short transaction (only while the
 *    row is still PENDING) and the next call follows after 2, 4, 8, 16, 32 s (MERCURY_RETRY_BASE_MS doubling).
 * 4. The final state (IMPORTED with the latest CONFIRMED document, NOT_FOUND, FAILED after the 6th failure) in ONE
 *    transaction that starts with the claim, locks the row FOR NO KEY UPDATE and writes only while it is still PENDING, with
 *    the audit row `system.vsdImport` (entityType batchDocument); `updated_at` comes from the touch trigger.
 *
 * Mercury being down is never a handler failure: the message is acknowledged after FAILED. The batch is never touched.
 */
import { sql } from 'kysely';
import { addDaysToDate, utcDate } from '@agrotrace/domain';
import type { Db } from '../../db/db.js';
import type { Logger } from '../../logger.js';
import { pickVsd, type Mercury, type Vsd } from '../../infra/mercury.js';
import type { EventEnvelope } from '../../infra/outbox.js';
import { auditDiff, auditService } from '../audit/service.js';
import { claimEvent } from '../../events/claim.js';

export const MERCURY_CALLS = 6;
const LAST_ERROR_MAX = 500;

interface VsdImportData {
  documentId: string;
  batchId: string;
  publicCode: string;
}

type Outcome =
  | { status: 'IMPORTED'; vsd: Vsd; calls: number }
  | { status: 'NOT_FOUND'; calls: number }
  | { status: 'FAILED'; error: string; calls: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function vsdImportHandler(deps: {
  db: Db;
  mercury: Mercury;
  logger: Logger;
  retryBaseMs: number;
  sleepMs?: (ms: number) => Promise<unknown>;
}) {
  const { db, mercury, logger } = deps;
  const wait = deps.sleepMs ?? sleep;

  async function alreadyClaimed(eventId: string): Promise<boolean> {
    const r = await db
      .selectFrom('processed_events')
      .select('event_id')
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    return r !== undefined;
  }

  /** The claim alone (nothing else to do). */
  async function claimOnly(eventId: string): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await claimEvent(tx, eventId);
    });
  }

  async function recordFailure(documentId: string, error: string): Promise<void> {
    await db
      .updateTable('batch_documents')
      .set({ attempts: sql`attempts + 1`, last_error: error.slice(0, LAST_ERROR_MAX) })
      .where('id', '=', documentId)
      .where('import_status', '=', 'PENDING')
      .execute();
  }

  async function finish(event: EventEnvelope, documentId: string, outcome: Outcome): Promise<void> {
    await db.transaction().execute(async (tx) => {
      if (!(await claimEvent(tx, event.id))) return;
      const row = await tx
        .selectFrom('batch_documents')
        .select(['id', 'import_status', 'attempts', 'last_error'])
        .where('id', '=', documentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.import_status !== 'PENDING') return;
      // The calls before the last one were counted by recordFailure; the last one is counted here.
      const lastCall = outcome.calls > 0 ? 1 : 0;
      const attempts = row.attempts + lastCall;
      const set =
        outcome.status === 'IMPORTED'
          ? {
              import_status: 'IMPORTED',
              external_uuid: outcome.vsd.uuid,
              number: outcome.vsd.number,
              issue_date: outcome.vsd.issueDate,
              vsd_status: outcome.vsd.status,
              payload: JSON.stringify(outcome.vsd),
              attempts,
              last_error: null,
            }
          : outcome.status === 'NOT_FOUND'
            ? { import_status: 'NOT_FOUND', attempts, last_error: null }
            : { import_status: 'FAILED', attempts, last_error: outcome.error.slice(0, LAST_ERROR_MAX) };
      await tx.updateTable('batch_documents').set(set).where('id', '=', documentId).execute();
      const before = {
        importStatus: row.import_status,
        attempts: row.attempts,
        lastError: row.last_error,
        externalUuid: null,
        number: null,
        issueDate: null,
        vsdStatus: null,
      };
      const after = {
        importStatus: set.import_status,
        attempts,
        lastError: set.last_error,
        externalUuid: outcome.status === 'IMPORTED' ? outcome.vsd.uuid : null,
        number: outcome.status === 'IMPORTED' ? outcome.vsd.number : null,
        issueDate: outcome.status === 'IMPORTED' ? outcome.vsd.issueDate : null,
        vsdStatus: outcome.status === 'IMPORTED' ? outcome.vsd.status : null,
      };
      await auditService.record(tx, {
        actorId: null,
        action: 'system.vsdImport',
        entityType: 'batchDocument',
        entityId: documentId,
        diff: auditDiff(before, after),
      });
    });
  }

  return async function handle(event: EventEnvelope): Promise<void> {
    const data = event.data as unknown as VsdImportData;
    if (await alreadyClaimed(event.id)) return;
    const src = await db
      .selectFrom('batch_documents as d')
      .innerJoin('batches as b', 'b.id', 'd.batch_id')
      .innerJoin('products as p', 'p.id', 'b.product_id')
      .innerJoin('organizations as o', 'o.id', 'b.origin_org_id')
      .select(['d.id', 'd.import_status', 'p.mercury_code', 'o.inn', 'b.harvested_at'])
      .where('d.id', '=', data.documentId)
      .executeTakeFirst();
    if (!src || src.import_status !== 'PENDING') {
      await claimOnly(event.id);
      return;
    }
    if (src.mercury_code === null || src.harvested_at === null) {
      await finish(event, src.id, { status: 'NOT_FOUND', calls: 0 });
      return;
    }
    const day = utcDate(new Date(src.harvested_at as unknown as Date).toISOString());
    const query = {
      productCode: src.mercury_code,
      senderInn: src.inn,
      dateFrom: addDaysToDate(day, -3),
      dateTo: addDaysToDate(day, 3),
    };
    for (let call = 1; ; call++) {
      const r = await mercury.listVsd(query);
      if (r.ok) {
        const vsd = pickVsd(r.items);
        await finish(
          event,
          src.id,
          vsd ? { status: 'IMPORTED', vsd, calls: call } : { status: 'NOT_FOUND', calls: call },
        );
        return;
      }
      logger.warn({ eventId: event.id, documentId: src.id, call, err: r.error }, 'mercury call failed');
      if (call >= MERCURY_CALLS) {
        await finish(event, src.id, { status: 'FAILED', error: r.error, calls: call });
        return;
      }
      await recordFailure(src.id, r.error);
      await wait(deps.retryBaseMs * 2 ** (call - 1));
    }
  };
}
