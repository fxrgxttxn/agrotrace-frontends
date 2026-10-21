/**
 * The storage half of the `notification.dispatch` algorithm (contracts/events/notification.dispatch.schema.json,
 * contracts/rules/notifications.json), shared by every writer that creates notifications inside its own transaction:
 * the `recall.requested` handler (Task 10) and the `notification.dispatch` handler (Task 12).
 *
 * Recipients: `userIds` as is, all users of `orgIds`, the heads (`is_org_admin`) of `orgHeadIds`, every user having a
 * role of `roles`; only ACTIVE, non-deleted users; the union deduplicated by user id. Per user: one IN_APP row
 * (DELIVERED; the table trigger emits pg_notify for SSE) and per external channel one PENDING row — EMAIL when
 * `channels.email` is true or the type is forced (RECALL, RECALL_TASK, OVERDUE), TELEGRAM when Telegram is linked and
 * (`channels.telegram` is true or the type is forced). Every row carries `payload`.
 *
 * Sending the PENDING rows after the commit (3 attempts, NOT_CONFIGURED) is the delivery half — Task 12; until then
 * they stay PENDING.
 */
import { sql, type Transaction } from 'kysely';
import rules from '../../../../contracts/rules/notifications.json' with { type: 'json' };
import type { DB } from '../../db/types.generated.js';

type Tx = Transaction<DB>;

export type NotificationType = keyof typeof rules.types;

export interface DispatchRecipients {
  userIds: readonly string[];
  orgIds: readonly string[];
  orgHeadIds: readonly string[];
  roles: readonly string[];
}

export interface DispatchData {
  notificationType: NotificationType;
  recipients: DispatchRecipients;
  payload: Record<string, unknown>;
}

const FORCED = new Set<string>(rules.forcedChannels);

/** Resolves the recipients and inserts the rows; returns the ids of the PENDING (external) rows to deliver. */
export async function insertNotifications(tx: Tx, d: DispatchData): Promise<string[]> {
  const r = d.recipients;
  const users = await sql<{ id: string; email: boolean; telegram: boolean; linked: boolean }>`
    SELECT u.id,
           coalesce((u.notification_channels->>'email')::boolean, false) AS email,
           coalesce((u.notification_channels->>'telegram')::boolean, false) AS telegram,
           u.telegram_chat_id IS NOT NULL AS linked
      FROM users u
     WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL
       AND (u.id = ANY(${[...r.userIds]}::uuid[])
            OR u.organization_id = ANY(${[...r.orgIds]}::uuid[])
            OR (u.is_org_admin AND u.organization_id = ANY(${[...r.orgHeadIds]}::uuid[]))
            OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                        WHERE ur.user_id = u.id AND ro.code = ANY(${[...r.roles]}::text[])))
     ORDER BY u.id`.execute(tx);
  if (users.rows.length === 0) return [];
  const forced = FORCED.has(d.notificationType);
  const payload = JSON.stringify(d.payload);
  const rows: { user_id: string; type: string; payload: string; channel: string; delivery_status: string }[] =
    [];
  for (const u of users.rows) {
    rows.push({
      user_id: u.id,
      type: d.notificationType,
      payload,
      channel: 'IN_APP',
      delivery_status: 'DELIVERED',
    });
    if (u.email || forced)
      rows.push({
        user_id: u.id,
        type: d.notificationType,
        payload,
        channel: 'EMAIL',
        delivery_status: 'PENDING',
      });
    if (u.linked && (u.telegram || forced))
      rows.push({
        user_id: u.id,
        type: d.notificationType,
        payload,
        channel: 'TELEGRAM',
        delivery_status: 'PENDING',
      });
  }
  const inserted = await tx
    .insertInto('notifications')
    .values(rows)
    .returning(['id', 'delivery_status'])
    .execute();
  return inserted.filter((x) => x.delivery_status === 'PENDING').map((x) => x.id);
}
