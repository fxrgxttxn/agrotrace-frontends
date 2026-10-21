/**
 * Scheduler job `recall-task-overdue` (tag Recalls, BR-08; entity-state-machines.json recallTask OPEN → OVERDUE,
 * `escalate`, by system): in ONE transaction the OPEN tasks past due — `status = 'OPEN' AND due_at < now()` (the DB
 * clock: now > dueAt) `FOR NO KEY UPDATE SKIP LOCKED` — become OVERDUE (`escalated_at` = now(), version + 1), each with the
 * audit row `system.recallTaskOverdue` (actor null) and a `notification.dispatch` OVERDUE outbox row (requestId null)
 * to the task's holder and the inspectors. A task locked by a running confirmation is skipped and seen next tick.
 */
import { sql } from 'kysely';
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import { auditService } from '../../modules/audit/service.js';
import { notify } from '../../modules/batches/lifecycle.js';
import { iso } from '../../modules/batches/view.js';
import type { Job } from '../runner.js';

export function recallTaskOverdueJob(db: Db): Job {
  return {
    name: 'recall-task-overdue',
    run: () =>
      withTx(db, async (tx) => {
        const due = await tx
          .selectFrom('recall_tasks')
          .select(['id', 'recall_id', 'batch_id', 'holder_org_id', 'status', 'due_at', 'version'])
          .where('status', '=', 'OPEN')
          .where(sql<boolean>`due_at < now()`)
          // Tasks of a soft-deleted recall are invisible and unconfirmable (tag Recalls): never escalated.
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM recalls r
              WHERE r.id = recall_tasks.recall_id AND r.deleted_at IS NOT NULL)`,
          )
          .orderBy('due_at')
          .orderBy('id')
          .forNoKeyUpdate()
          .skipLocked()
          .execute();
        if (due.length === 0) return 0;
        const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
        const codes = new Map(
          (
            await tx
              .selectFrom('batches')
              .select(['id', 'public_code'])
              .where(
                'id',
                'in',
                due.map((t) => t.batch_id),
              )
              .execute()
          ).map((b) => [b.id, b.public_code]),
        );
        const holders = new Map(
          (
            await tx
              .selectFrom('organizations')
              .select(['id', 'name'])
              .where(
                'id',
                'in',
                due.map((t) => t.holder_org_id),
              )
              .execute()
          ).map((o) => [o.id, o.name]),
        );
        for (const t of due) {
          await tx
            .updateTable('recall_tasks')
            .set({ status: 'OVERDUE', escalated_at: now, version: t.version + 1 })
            .where('id', '=', t.id)
            .execute();
          await auditService.record(tx, {
            actorId: null,
            action: 'system.recallTaskOverdue',
            entityType: 'recallTask',
            entityId: t.id,
            diff: {
              status: [t.status, 'OVERDUE'],
              escalatedAt: [null, iso(now)],
              version: [t.version, t.version + 1],
            },
          });
          await notify(
            tx,
            'OVERDUE',
            { orgIds: [t.holder_org_id], roles: ['INSPECTOR'] },
            {
              recallId: t.recall_id,
              taskId: t.id,
              batchId: t.batch_id,
              publicCode: codes.get(t.batch_id),
              dueAt: iso(t.due_at),
              holderOrgId: t.holder_org_id,
              holderName: holders.get(t.holder_org_id),
            },
          );
        }
        return due.length;
      }),
  };
}
