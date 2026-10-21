/**
 * `notification.dispatch` handler (worker; contracts/events/notification.dispatch.schema.json, R56): in ONE transaction
 * that starts with the processed_events claim, the recipients are expanded and the rows inserted
 * (modules/notifications/dispatch.ts — IN_APP DELIVERED, whose trigger emits pg_notify for SSE, and EMAIL/TELEGRAM
 * PENDING); after the commit the PENDING rows are sent (modules/notifications/delivery.ts). A redelivered event finds
 * its claim and creates and sends nothing.
 */
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import type { EventHandler } from '../../infra/consumer.js';
import type { Delivery } from '../../modules/notifications/delivery.js';
import { insertNotifications, type DispatchData } from '../../modules/notifications/dispatch.js';
import { claimEvent } from '../claim.js';

export function notificationDispatchHandler(deps: { db: Db; delivery: Delivery }): EventHandler {
  return async (event) => {
    const data = event.data as unknown as DispatchData;
    const pending = await withTx(deps.db, async (tx) => {
      if (!(await claimEvent(tx, event.id))) return [];
      return insertNotifications(tx, data);
    });
    deps.delivery.deliver(pending);
  };
}
