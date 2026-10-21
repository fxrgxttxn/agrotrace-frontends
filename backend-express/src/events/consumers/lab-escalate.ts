/**
 * `lab.escalate` handler (worker; contracts/events/lab.escalate.schema.json, R56): LAB_OVERDUE for the heads of the
 * lab organization and every inspector (contracts/rules/notifications.json), exactly like notification.dispatch, in
 * ONE transaction that starts with the processed_events claim; the PENDING EMAIL/TELEGRAM rows are sent after the
 * commit. Payload: the event's data plus the laboratory's name.
 */
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import type { EventHandler } from '../../infra/consumer.js';
import type { Delivery } from '../../modules/notifications/delivery.js';
import { insertNotifications } from '../../modules/notifications/dispatch.js';
import { claimEvent } from '../claim.js';

export interface LabEscalateData {
  labTestId: string;
  labOrgId: string;
  batchId: string;
  publicCode: string;
  dueAt: string;
  escalatedAt: string;
}

export function labEscalateHandler(deps: { db: Db; delivery: Delivery }): EventHandler {
  return async (event) => {
    const data = event.data as unknown as LabEscalateData;
    const pending = await withTx(deps.db, async (tx) => {
      if (!(await claimEvent(tx, event.id))) return [];
      const lab = await tx
        .selectFrom('organizations')
        .select('name')
        .where('id', '=', data.labOrgId)
        .executeTakeFirst();
      return insertNotifications(tx, {
        notificationType: 'LAB_OVERDUE',
        recipients: { userIds: [], orgIds: [], orgHeadIds: [data.labOrgId], roles: ['INSPECTOR'] },
        payload: {
          labTestId: data.labTestId,
          batchId: data.batchId,
          publicCode: data.publicCode,
          labOrgId: data.labOrgId,
          labName: lab?.name ?? '',
          dueAt: data.dueAt,
        },
      });
    });
    deps.delivery.deliver(pending);
  };
}
