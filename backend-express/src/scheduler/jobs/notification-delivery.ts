/**
 * Scheduler job `notification-delivery` (P49, contracts/events/notification.dispatch.schema.json): every tick it claims
 * the PENDING EMAIL/TELEGRAM rows whose sender died — `coalesce(claimed_at, created_at)` older than 5 minutes, `FOR
 * UPDATE SKIP LOCKED` — and sends them within the rest of their 3-attempt budget (modules/notifications/delivery.ts).
 * Any implementation's sweeper may take any such row: the claim makes a second sender skip it for 5 minutes.
 */
import type { Delivery } from '../../modules/notifications/delivery.js';
import type { Job } from '../runner.js';

export function notificationDeliveryJob(delivery: Delivery): Job {
  return { name: 'notification-delivery', run: () => delivery.sweep() };
}
