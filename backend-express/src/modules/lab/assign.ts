/**
 * An unplanned lab test as createLabTest makes it (tag Lab): QUEUED, `dueAt` = addWorkingDays(now, 5), `created_by` =
 * the inspector, version 1, the audit row, LAB_ASSIGNED to the laboratory and the batch origin (notifications.json
 * `labOrg`, `batchOrigin`). Shared by createLabTest (reason INSPECTOR) and decideComplaint LAB_TEST (reason COMPLAINT).
 * The caller has checked the batch and the laboratory (ACTIVE, type LAB).
 */
import { sql, type Transaction } from 'kysely';
import { addWorkingDays } from '@agrotrace/domain';
import type { DB } from '../../db/types.generated.js';
import { auditDiff, auditService } from '../audit/service.js';
import { notify } from '../batches/lifecycle.js';

export interface UnplannedTest {
  batch: { id: string; public_code: string; origin_org_id: string; product_name: string };
  lab: { id: string; name: string };
  reason: 'INSPECTOR' | 'COMPLAINT';
  actorId: string;
  /** operationId for the audit row. */
  action: string;
}

export async function insertUnplannedLabTest(
  tx: Transaction<DB>,
  t: UnplannedTest,
): Promise<{ id: string; dueAt: string }> {
  const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
  const dueAt = addWorkingDays({ from: now.toISOString(), days: 5 }).result;
  const row = await tx
    .insertInto('lab_tests')
    .values({
      batch_id: t.batch.id,
      lab_org_id: t.lab.id,
      reason: t.reason,
      status: 'QUEUED',
      due_at: dueAt,
      created_at: now,
      created_by: t.actorId,
      version: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await auditService.record(tx, {
    actorId: t.actorId,
    action: t.action,
    entityType: 'labTest',
    entityId: row.id,
    diff: auditDiff(null, {
      batchId: t.batch.id,
      labOrgId: t.lab.id,
      reason: t.reason,
      status: 'QUEUED',
      dueAt,
      version: 1,
    }),
  });
  await notify(
    tx,
    'LAB_ASSIGNED',
    { orgIds: [t.lab.id, t.batch.origin_org_id] },
    {
      labTestId: row.id,
      batchId: t.batch.id,
      publicCode: t.batch.public_code,
      productName: t.batch.product_name,
      labOrgId: t.lab.id,
      labName: t.lab.name,
      reason: t.reason,
      dueAt,
    },
  );
  return { id: row.id, dueAt };
}
