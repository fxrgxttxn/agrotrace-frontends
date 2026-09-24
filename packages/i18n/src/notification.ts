import { formatDateTime } from './format.js';
import type { T } from './problem.js';

/** Template of a notification (R87): in-app title/body, email subject/body, Telegram text. */
export type NotificationPart = 'title' | 'body' | 'email.subject' | 'email.body' | 'telegram';

/**
 * Payload keys (contracts/rules/notifications.json) whose values are enum codes, rendered through their label
 * namespace: LAB_ASSIGNED `reason`, LAB_RESULT `conclusion`, RECALL `trigger`.
 */
export const NOTIFICATION_PARAM_LABELS: Record<string, string> = {
  reason: 'labTestReason',
  conclusion: 'labConclusion',
  trigger: 'recallTrigger',
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Renders one part of a notification from its `type` and `payload` (R87). Types whose payload carries `event`
 * (RECALL: OPENED/CLOSED, RECALL_TASK: CREATED/REASSIGNED) use `notification.<TYPE>.<event>.<part>`, the others
 * `notification.<TYPE>.<part>`. Params: enum codes → labels (`NOTIFICATION_PARAM_LABELS`), `*At` instants →
 * `formatDateTime`, other strings and numbers as they are. The same rules apply to the email and Telegram texts
 * the backends send (they read the same locale files).
 */
export function notificationMessage(
  type: string,
  payload: Record<string, unknown>,
  part: NotificationPart,
  t: T,
): string {
  const locale = t.locale ?? 'ru';
  const event = typeof payload.event === 'string' ? payload.event : undefined;
  const key = event ? `notification.${type}.${event}.${part}` : `notification.${type}.${part}`;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === 'string' && NOTIFICATION_PARAM_LABELS[name]) {
      const labelKey = `${NOTIFICATION_PARAM_LABELS[name]}.${value}`;
      const label = t(labelKey);
      params[name] = label === labelKey ? value : label;
    } else if (typeof value === 'string' && name.endsWith('At') && ISO_DATETIME.test(value))
      params[name] = formatDateTime(value, locale);
    else if (typeof value === 'string' || typeof value === 'number') params[name] = value;
  }
  return t(key, params);
}
