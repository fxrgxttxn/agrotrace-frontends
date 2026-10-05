import rules from '../../../../contracts/rules/notifications.json' with { type: 'json' };
import type { Store } from '../store/store.js';
import type { NotificationRow, RoleCode } from '../store/types.js';

export type NotificationType = keyof typeof rules.types;

export interface Recipients {
  users?: string[];
  orgs?: string[];
  orgHeads?: string[];
  roles?: RoleCode[];
}

export type NotificationListener = (row: NotificationRow) => void;

const listeners = new WeakMap<Store, NotificationListener>();

export function onNotification(store: Store, fn: NotificationListener): void {
  listeners.set(store, fn);
}

export function notify(store: Store, type: NotificationType, recipients: Recipients, payload: Record<string, unknown>): void {
  const keys = [...rules.types[type].payload].sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(payload).sort()))
    throw new Error(`${type}: payload keys ${Object.keys(payload).join(',')}`);
  store.afterCommit(() => {
    const active = store.t.users.filter((u) => u.status === 'ACTIVE' && u.deleted_at === null);
    const ids: string[] = [];
    const add = (list: string[]): void => {
      for (const id of list) if (!ids.includes(id)) ids.push(id);
    };
    add(active.filter((u) => (recipients.users ?? []).includes(u.id)).map((u) => u.id));
    for (const org of recipients.orgs ?? []) add(active.filter((u) => u.organization_id === org).map((u) => u.id));
    for (const org of recipients.orgHeads ?? [])
      add(active.filter((u) => u.organization_id === org && u.is_org_admin).map((u) => u.id));
    for (const role of recipients.roles ?? []) add(active.filter((u) => u.roles.includes(role)).map((u) => u.id));
    for (const userId of ids) {
      store.markDirty();
      store.seq.notification += 1;
      const row: NotificationRow = {
        id: store.id('notification'),
        seq: store.seq.notification,
        user_id: userId,
        type,
        payload: structuredClone(payload),
        is_read: false,
        created_at: store.nowIso(),
      };
      store.insert('notifications', row);
      listeners.get(store)?.(row);
    }
  });
}

export const unreadCount = (store: Store, userId: string): number =>
  store.t.notifications.filter((n) => n.user_id === userId && !n.is_read).length;
