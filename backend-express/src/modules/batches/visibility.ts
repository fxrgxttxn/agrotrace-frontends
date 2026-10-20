/**
 * Batch visibility (п. 4.2, tag Batches): deleted batches are seen by nobody; several roles — the union.
 *
 * - INSPECTOR and ADMIN — every batch;
 * - LAB — batches with a non-deleted lab test of its laboratory;
 * - FARMER, PROCESSOR, RETAILER — S ∪ N: S = batches the organization originates or holds, or that are in a waybill
 *   with status SENT, ACCEPTED or REJECTED (not deleted) it sends or receives; N = direct parents and children of S in
 *   `batch_links`.
 *
 * An invisible batch is indistinguishable from a missing one (404). The predicates are SQL so lists filter in the DB.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';
import type { Principal } from '../../security/jwt.js';

export const seesAll = (p: Principal): boolean => p.roles.includes('INSPECTOR') || p.roles.includes('ADMIN');

/** FARMER, PROCESSOR or RETAILER — an organization that can originate, hold, send and receive batches. */
export const isParticipant = (p: Principal): boolean =>
  p.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR' || r === 'RETAILER');

/** `SELECT id …` of S ∪ N for the organization (non-deleted filtering is the caller's `b.deleted_at IS NULL`). */
export function participantBatchIds(orgId: string): RawBuilder<{ id: string }> {
  return sql<{ id: string }>`
    WITH s AS (
      SELECT b.id FROM batches b
       WHERE b.deleted_at IS NULL AND (b.origin_org_id = ${orgId} OR b.holder_org_id = ${orgId})
      UNION
      SELECT wi.batch_id FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
       WHERE w.deleted_at IS NULL AND w.status IN ('SENT', 'ACCEPTED', 'REJECTED')
         AND (w.sender_org_id = ${orgId} OR w.receiver_org_id = ${orgId})
    )
    SELECT id FROM s
    UNION SELECT l.child_batch_id FROM batch_links l WHERE l.parent_batch_id IN (SELECT id FROM s)
    UNION SELECT l.parent_batch_id FROM batch_links l WHERE l.child_batch_id IN (SELECT id FROM s)`;
}

/** Whether the batch with id `batchId` (a column reference or a value) is visible to `p` — deletion not included. */
export function batchVisibleTo(
  p: Principal,
  batchId: Expression<string> | RawBuilder<string>,
): RawBuilder<boolean> {
  if (seesAll(p)) return sql<boolean>`true`;
  const parts: RawBuilder<boolean>[] = [];
  if (p.roles.includes('LAB'))
    parts.push(sql<boolean>`EXISTS (SELECT 1 FROM lab_tests t
      WHERE t.batch_id = ${batchId} AND t.deleted_at IS NULL AND t.lab_org_id = ${p.orgId})`);
  if (isParticipant(p)) parts.push(sql<boolean>`${batchId} IN (${participantBatchIds(p.orgId)})`);
  if (parts.length === 0) return sql<boolean>`false`;
  return sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}
