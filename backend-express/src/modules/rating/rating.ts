/**
 * BR-09 trust rating (contracts/events/rating.recalculate.schema.json, contracts/rules/trust-rating.json): a full
 * recomputation, never a delta — so any number of deliveries, in any order, yields the same rating.
 *
 * Under the organization's row lock (`FOR UPDATE`; R52 `organization`), for a FARM only: the left fold of
 * `nextTrustRating` (@agrotrace/domain) from `initial` over every event of the farm, ordered by time asc, then lab
 * events before recall events, then id asc (code points):
 *   - every non-deleted lab test with status DONE on a non-deleted batch the farm originated — LAB_PASS / LAB_FAIL at
 *     `completed_at`;
 *   - every non-deleted recall whose source batch the farm originated — RECALL_SOURCE at `opened_at`.
 * A changed result is stored with the audit row `system.ratingRecalculate` (actor null, entityType organization,
 * diff `trustRating`). Other organization types are ignored.
 */
import { sql, type Transaction } from 'kysely';
import { nextTrustRating } from '@agrotrace/domain';
import trustRules from '../../../../contracts/rules/trust-rating.json' with { type: 'json' };
import type { DB } from '../../db/types.generated.js';
import { auditService } from '../audit/service.js';

type RatingEvent = 'LAB_PASS' | 'LAB_FAIL' | 'RECALL_SOURCE';

export interface RatingOutcome {
  /** null — not a FARM (or no such organization): nothing done. */
  before: number | null;
  after: number | null;
  changed: boolean;
}

/** The fold of the farm's events (no lock, no write) — exported for diagnostics and unit tests. */
export async function foldTrustRating(tx: Transaction<DB>, orgId: string): Promise<number> {
  const events = await sql<{ event: RatingEvent }>`
    SELECT e.event FROM (
      SELECT t.completed_at AS at, 0 AS kind, t.id::text AS id,
             CASE t.conclusion WHEN 'PASS' THEN 'LAB_PASS' ELSE 'LAB_FAIL' END AS event
        FROM lab_tests t JOIN batches b ON b.id = t.batch_id
       WHERE t.status = 'DONE' AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.origin_org_id = ${orgId}
      UNION ALL
      SELECT r.opened_at, 1, r.id::text, 'RECALL_SOURCE'
        FROM recalls r JOIN batches b ON b.id = r.source_batch_id
       WHERE r.deleted_at IS NULL AND b.origin_org_id = ${orgId}
    ) e
    ORDER BY e.at, e.kind, e.id COLLATE "C"`.execute(tx);
  return events.rows.reduce(
    (current, e) => nextTrustRating({ current, event: e.event }).rating,
    trustRules.initial,
  );
}

/** Recomputes and stores the rating of `orgId` inside `tx` (the caller's transaction, after its event claim). */
export async function recalculateTrustRating(tx: Transaction<DB>, orgId: string): Promise<RatingOutcome> {
  const org = await tx
    .selectFrom('organizations')
    .select(['id', 'type', 'trust_rating'])
    .where('id', '=', orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!org || org.type !== 'FARM') return { before: null, after: null, changed: false };
  const rating = await foldTrustRating(tx, orgId);
  if (rating === org.trust_rating) return { before: org.trust_rating, after: rating, changed: false };
  await tx.updateTable('organizations').set({ trust_rating: rating }).where('id', '=', orgId).execute();
  await auditService.record(tx, {
    actorId: null,
    action: 'system.ratingRecalculate',
    entityType: 'organization',
    entityId: orgId,
    diff: { trustRating: [org.trust_rating, rating] },
  });
  return { before: org.trust_rating, after: rating, changed: true };
}
