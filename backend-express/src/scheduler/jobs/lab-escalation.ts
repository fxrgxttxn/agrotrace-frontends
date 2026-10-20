/**
 * Scheduler job `lab-escalation` (tag Lab, БП-2; contracts/events/lab.escalate.schema.json): in ONE transaction the
 * open tests past due — `status IN ('QUEUED','SAMPLED') AND due_at < now() AND deleted_at IS NULL FOR UPDATE SKIP
 * LOCKED` (isOverdue: now > dueAt, the DB clock) — become ESCALATED (`escalated_at` = now(), version + 1), each with an
 * audit row `system.labTestEscalate` (actor null) and a `lab.escalate` outbox row (requestId null). The worker's
 * handler (Task 12) sends LAB_OVERDUE to the lab heads and the inspectors.
 */
import { sql } from 'kysely';
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import { enqueue } from '../../infra/outbox.js';
import { auditService } from '../../modules/audit/service.js';
import { iso } from '../../modules/batches/view.js';
import type { Job } from '../runner.js';

export function labEscalationJob(db: Db): Job {
  return {
    name: 'lab-escalation',
    run: () =>
      withTx(db, async (tx) => {
        const due = await tx
          .selectFrom('lab_tests')
          .select(['id', 'lab_org_id', 'batch_id', 'status', 'due_at', 'version'])
          .where('status', 'in', ['QUEUED', 'SAMPLED'])
          .where(sql<boolean>`due_at < now()`)
          .where('deleted_at', 'is', null)
          .orderBy('due_at')
          .orderBy('id')
          .forUpdate()
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
        for (const t of due) {
          await tx
            .updateTable('lab_tests')
            .set({ status: 'ESCALATED', escalated_at: now, version: t.version + 1 })
            .where('id', '=', t.id)
            .execute();
          await auditService.record(tx, {
            actorId: null,
            action: 'system.labTestEscalate',
            entityType: 'labTest',
            entityId: t.id,
            diff: {
              status: [t.status, 'ESCALATED'],
              escalatedAt: [null, iso(now)],
              version: [t.version, t.version + 1],
            },
          });
          await enqueue(tx, {
            type: 'lab.escalate',
            requestId: null,
            payload: {
              labTestId: t.id,
              labOrgId: t.lab_org_id,
              batchId: t.batch_id,
              publicCode: codes.get(t.batch_id),
              dueAt: iso(t.due_at),
              escalatedAt: iso(now),
            },
          });
        }
        return due.length;
      }),
  };
}
