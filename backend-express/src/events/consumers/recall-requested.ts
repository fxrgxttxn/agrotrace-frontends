/**
 * `recall.requested` handler (worker; contracts/events/recall.requested.schema.json, tag Recalls, R55/R56, R89).
 * The recall itself is already committed by the operation that created it; the handler only fans out, in ONE
 * transaction that starts with the processed_events claim:
 *
 *   1. RECALL {event: OPENED} to the inspectors, every task holder and the source batch's origin — skipped for a
 *      recall without tasks (closed at creation, BR-10): its RECALL CLOSED was written in the creating transaction,
 *      and an OPENED after it would contradict it (R89);
 *   2. RECALL_TASK {event: CREATED} per task to its holder;
 *   3. `rating.recalculate {cause: RECALL_SOURCE, sourceId: recallId}` into the outbox when the source's origin is a
 *      FARM (published right after the commit; the sweeper retries).
 *
 * Notifications (1) and (2) are written with the notification.dispatch algorithm (modules/notifications/dispatch.ts);
 * a redelivered event finds its claim and creates nothing.
 */
import { sql } from 'kysely';
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import type { EventHandler } from '../../infra/consumer.js';
import { enqueue } from '../../infra/outbox.js';
import type { OutboxRelay } from '../../infra/relay.js';
import { iso } from '../../modules/batches/view.js';
import { insertNotifications } from '../../modules/notifications/dispatch.js';
import { claimEvent } from '../claim.js';

export interface RecallRequestedData {
  recallId: string;
  sourceBatchId: string;
  trigger: 'LAB' | 'INSPECTOR' | 'COMPLAINT';
  openedBy: string | null;
}

export function recallRequestedHandler(deps: { db: Db; relay: OutboxRelay }): EventHandler {
  const { db, relay } = deps;
  return async (event) => {
    const data = event.data as unknown as RecallRequestedData;
    const publish = await withTx(db, async (tx) => {
      if (!(await claimEvent(tx, event.id))) return [];
      const r = await tx
        .selectFrom('recalls as r')
        .innerJoin('batches as b', 'b.id', 'r.source_batch_id')
        .innerJoin('organizations as o', 'o.id', 'b.origin_org_id')
        .select([
          'r.id',
          'r.trigger',
          'b.id as batch_id',
          'b.public_code',
          'b.origin_org_id',
          'o.type as origin_type',
        ])
        .where('r.id', '=', data.recallId)
        .executeTakeFirst();
      if (!r) return [];
      const tasks = await tx
        .selectFrom('recall_tasks as t')
        .innerJoin('batches as b', 'b.id', 't.batch_id')
        .select(['t.id', 't.holder_org_id', 't.batch_id', 't.due_at', 'b.public_code'])
        .where('t.recall_id', '=', r.id)
        .orderBy(sql`t.id::text COLLATE "C"`)
        .execute();
      if (tasks.length > 0)
        await insertNotifications(tx, {
          notificationType: 'RECALL',
          recipients: {
            userIds: [],
            orgIds: [...new Set([...tasks.map((t) => t.holder_org_id), r.origin_org_id])],
            orgHeadIds: [],
            roles: ['INSPECTOR'],
          },
          payload: {
            recallId: r.id,
            event: 'OPENED',
            sourceBatchId: r.batch_id,
            publicCode: r.public_code,
            trigger: r.trigger,
          },
        });
      for (const t of tasks)
        await insertNotifications(tx, {
          notificationType: 'RECALL_TASK',
          recipients: { userIds: [], orgIds: [t.holder_org_id], orgHeadIds: [], roles: [] },
          payload: {
            recallId: r.id,
            taskId: t.id,
            batchId: t.batch_id,
            publicCode: t.public_code,
            dueAt: iso(t.due_at),
            event: 'CREATED',
          },
        });
      if (r.origin_type !== 'FARM') return [];
      const ev = await enqueue(tx, {
        type: 'rating.recalculate',
        requestId: event.requestId,
        payload: { organizationId: r.origin_org_id, cause: 'RECALL_SOURCE', sourceId: r.id },
      });
      return [ev.id];
    });
    await relay.publish(publish);
  };
}
