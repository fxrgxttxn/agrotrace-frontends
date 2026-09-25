/**
 * Audit log writer (contract `AuditEntry`, spec 8.8): one row per changed entity row, in the SAME transaction as the
 * change; `action` = operationId, `diff` = { apiField: [before, after] } over the changed fields only, API formats,
 * secrets (password, TOTP, tokens, hashes) as "***" on both sides; creation → before = null for every filled field.
 * `ip` and `request_id` come from the request context. Minimal version (Task 2); Task 4 adds the reading side.
 */
import type { Transaction } from 'kysely';
import { currentIp, currentRequestId } from '../../context.js';
import type { DB } from '../../db/types.generated.js';

export type AuditEntityType =
  | 'organization'
  | 'user'
  | 'field'
  | 'treatment'
  | 'batch'
  | 'waybill'
  | 'labTest'
  | 'recall'
  | 'recallTask'
  | 'complaint'
  | 'product'
  | 'substance'
  | 'indicator'
  | 'norm'
  | 'region'
  | 'file'
  | 'batchDocument';

export const SECRET = '***';

export type AuditDiff = Record<string, [unknown, unknown]>;

export interface AuditEntry {
  /** The acting user; null — system, seed, anonymous buyer. */
  actorId: string | null;
  /** operationId (or `system.<job>`). */
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  diff: AuditDiff;
}

/**
 * `{field: [before, after]}` over the fields whose values differ (JSON equality); `before` = null → a creation: every
 * non-null field of `after` with null before. Values must already be in API format.
 */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): AuditDiff {
  const out: AuditDiff = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before ? (before[k] ?? null) : null;
    if (before === null && (v === null || v === undefined)) continue;
    if (JSON.stringify(b) !== JSON.stringify(v ?? null)) out[k] = [b, v ?? null];
  }
  return out;
}

export async function record(tx: Transaction<DB>, e: AuditEntry): Promise<void> {
  await tx
    .insertInto('audit_log')
    .values({
      actor_id: e.actorId,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId,
      diff: JSON.stringify(e.diff),
      ip: currentIp(),
      backend: 'express',
      request_id: currentRequestId(),
    })
    .execute();
}

export const auditService = { record };
