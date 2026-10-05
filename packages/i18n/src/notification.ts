import { formatDateTime } from './format.js';
import type { T } from './problem.js';

export type NotificationPart = 'title' | 'body' | 'email.subject' | 'email.body' | 'telegram';

export const NOTIFICATION_PARAM_LABELS: Record<string, string> = {
  reason: 'labTestReason',
  conclusion: 'labConclusion',
  trigger: 'recallTrigger',
};

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
