/**
 * Batch status transitions (contracts/rules/state-machine.json via @agrotrace/domain `canTransition`): every
 * transition — automatic ones included — increments `version` by 1 and writes a `batch_status_history` row (`reason`,
 * author or null for the server). The caller holds the batch row lock (R47) and has checked the transition.
 */
import { sql, type Transaction } from 'kysely';
import { canTransition, type BatchStatus } from '@agrotrace/domain';
import type { DB } from '../../db/types.generated.js';
import { enqueue } from '../../infra/outbox.js';

export type StatusReason =
  | 'CREATED'
  | 'TEST_REQUIRED'
  | 'TEST_NOT_REQUIRED'
  | 'LAB_PASS'
  | 'LAB_FAIL'
  | 'WAYBILL_SENT'
  | 'WAYBILL_ACCEPTED'
  | 'WAYBILL_REJECTED'
  | 'PROCESSED'
  | 'ON_SALE'
  | 'SOLD'
  | 'RECALLED'
  | 'WRITTEN_OFF';

export const canBatchGo = (from: string, to: BatchStatus): boolean =>
  canTransition({ from: from as BatchStatus, to }).allowed;

/** Moves the locked batch `from` → `to`; returns the new version. `extra` — further columns of the same UPDATE. */
export async function transitionBatch(
  tx: Transaction<DB>,
  b: { id: string; status: string; version: number },
  to: BatchStatus,
  reason: StatusReason,
  byUserId: string | null,
  extra: { holder_org_id?: string; mass_kg?: string } = {},
): Promise<number> {
  if (!canBatchGo(b.status, to)) throw new Error(`batch ${b.id}: ${b.status} → ${to} is not a transition`);
  const version = b.version + 1;
  await tx
    .updateTable('batches')
    .set({ status: to, version, ...extra })
    .where('id', '=', b.id)
    .execute();
  await tx
    .insertInto('batch_status_history')
    .values({
      batch_id: b.id,
      from_status: b.status,
      to_status: to,
      changed_by: byUserId,
      reason,
      changed_at: sql`now()`,
    })
    .execute();
  return version;
}

export interface Recipients {
  userIds?: string[];
  orgIds?: string[];
  orgHeadIds?: string[];
  roles?: string[];
}

/**
 * `notification.dispatch` into the outbox (contracts/rules/notifications.json: the type's recipients as logical groups
 * resolved to ids here, `payload` with exactly the type's keys). Delivery is the worker's (Task 12).
 */
export async function notify(
  tx: Transaction<DB>,
  notificationType: string,
  recipients: Recipients,
  payload: Record<string, unknown>,
): Promise<void> {
  const uniq = (xs?: string[]) => [...new Set(xs ?? [])];
  await enqueue(tx, {
    type: 'notification.dispatch',
    payload: {
      notificationType,
      recipients: {
        userIds: uniq(recipients.userIds),
        orgIds: uniq(recipients.orgIds),
        orgHeadIds: uniq(recipients.orgHeadIds),
        roles: uniq(recipients.roles),
      },
      payload,
    },
  });
}
