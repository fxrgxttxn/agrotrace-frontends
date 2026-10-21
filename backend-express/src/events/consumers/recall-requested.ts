/**
 * `recall.requested` handler (worker; contracts/events/recall.requested.schema.json, tag Recalls, R55/R56, R89).
 * The recall itself is already committed by the operation that created it; the handler only fans out, in ONE
 * transaction that starts with the processed_events claim:
 *
 *   1. RECALL {event: OPENED} to the inspectors, every task holder and the source batch's origin — skipped when the
 *      recall is no longer OPEN (closed at creation without tasks, BR-10, or all tasks confirmed before the handler ran)
 *      or is soft-deleted: its RECALL CLOSED is already written and an OPENED after it would contradict it (R89);
 *   2. RECALL_TASK {event: CREATED} per task to its holder;
 *   3. `rating.recalculate {cause: RECALL_SOURCE, sourceId: recallId}` into the outbox when the source's origin is a
 *      FARM (published right after the commit; the sweeper retries).
 *
 * Notifications (1) and (2) are written with the notification.dispatch algorithm (modules/notifications/dispatch.ts);
 * a redelivered event finds its claim and creates nothing. The PENDING EMAIL/TELEGRAM rows are sent after the commit
 * (modules/notifications/delivery.ts).
 */
import { sql } from 'kysely';
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import type { EventHandler } from '../../infra/consumer.js';
import { enqueue } from '../../infra/outbox.js';
import type { OutboxRelay } from '../../infra/relay.js';
import { iso } from '../../modules/batches/view.js';
import type { Delivery } from '../../modules/notifications/delivery.js';
import { insertNotifications } from '../../modules/notifications/dispatch.js';
import { claimEvent } from '../claim.js';

export interface RecallRequestedData {
  recallId: string;
  sourceBatchId: string;
  trigger: 'LAB' | 'INSPECTOR' | 'COMPLAINT';
  openedBy: string | null;
}

export function recallRequestedHandler(deps: {
  db: Db;
  relay: OutboxRelay;
  delivery: Delivery;
}): EventHandler {
  const { db, relay, delivery } = deps;
  return async (event) => {
    const data = event.data as unknown as RecallRequestedData;
    const out = await withTx(db, async (tx) => {
      const pending: string[] = [];
      const none = { publish: [] as string[], pending };
      if (!(await claimEvent(tx, event.id))) return none;
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
          'r.status',
          'r.deleted_at',
        ])
        .where('r.id', '=', data.recallId)
        .executeTakeFirst();
      if (!r) return none;
      const tasks = await tx
        .selectFrom('recall_tasks as t')
        .innerJoin('batches as b', 'b.id', 't.batch_id')
        .select(['t.id', 't.holder_org_id', 't.batch_id', 't.due_at', 'b.public_code'])
        .where('t.recall_id', '=', r.id)
        .orderBy(sql`t.id::text COLLATE "C"`)
        .execute();
      // R89: no OPENED once the recall is no longer OPEN (closed at creation, or every task confirmed before this
      // handler ran — its CLOSED is already written) or is soft-deleted.
      if (r.status === 'OPEN' && r.deleted_at === null && tasks.length > 0)
        pending.push(
          ...(await insertNotifications(tx, {
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
          })),
        );
      for (const t of tasks)
        pending.push(
          ...(await insertNotifications(tx, {
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
          })),
        );
      if (r.origin_type !== 'FARM') return none;
      const ev = await enqueue(tx, {
        type: 'rating.recalculate',
        requestId: event.requestId,
        payload: { organizationId: r.origin_org_id, cause: 'RECALL_SOURCE', sourceId: r.id },
      });
      return { publish: [ev.id], pending };
    });
    delivery.deliver(out.pending);
    await relay.publish(out.publish);
  };
}
