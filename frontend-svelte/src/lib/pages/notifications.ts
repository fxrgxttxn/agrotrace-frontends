import type { ApiNotification } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { canAccess, type Viewer } from '../app/access';
import { t } from '../app/i18n';
import { CABINET_ROUTES, matchPath } from '../app/routes';

// Notification texts and links (the same rules as the React app, src/pages/notifications.tsx there).

/** Where a notification leads, in order of preference (payload keys: contracts/rules/notifications.json). */
function targets(n: ApiNotification): string[] {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const at = (...parts: unknown[]) =>
    parts.every((x) => typeof x === 'string' && x !== '') ? parts.join('') : null;
  const list: (string | null)[] = (() => {
    switch (n.type) {
      case 'LAB_ASSIGNED':
      case 'LAB_OVERDUE':
        return [at('/lab/tests/', p.labTestId), at('/batches/', p.batchId)];
      case 'LAB_RESULT':
        return [at('/batches/', p.batchId, '?tab=tests'), at('/lab/tests/', p.labTestId)];
      case 'WAYBILL_INCOMING':
        return [at('/waybills/', p.waybillId)];
      case 'RECALL':
        return [at('/recalls/', p.recallId), at('/batches/', p.sourceBatchId)];
      case 'RECALL_TASK':
        return ['/recall-tasks', at('/recalls/', p.recallId), at('/batches/', p.batchId)];
      case 'OVERDUE':
        return [at('/recalls/', p.recallId), '/recall-tasks'];
      case 'COMPLAINT':
        return [at('/complaints/', p.complaintId), at('/batches/', p.batchId)];
      default:
        return [];
    }
  })();
  return list.filter((x): x is string => x !== null);
}

/** The first target the viewer may open (routes and roles of §9.4, F3); none — the notification is plain text. */
export function linkFor(n: ApiNotification, viewer: Viewer): string | null {
  for (const href of targets(n)) {
    const path = href.split('?')[0]!;
    const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
    if (route && canAccess(viewer, route.access)) return href;
  }
  return null;
}

/** Title or body text of a notification. */
export const notificationText = (n: ApiNotification, part: 'title' | 'body'): string =>
  notificationMessage(n.type, (n.payload ?? {}) as Record<string, unknown>, part, t);
