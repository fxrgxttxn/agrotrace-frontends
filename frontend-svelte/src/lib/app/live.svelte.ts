import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { cache } from './cache.svelte';
import { t } from './i18n';
import { apiBaseUrl, type Session } from './session.svelte';
import { toasts } from '../ui/toast-store.svelte';

export interface StreamOptions {
  EventSourceImpl?: typeof EventSource;
}

export function eventStream(
  session: Session,
  onEvent: (e: StreamEvent) => void,
  { EventSourceImpl }: StreamOptions = {},
): () => void {
  const Impl = EventSourceImpl ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
  if (!Impl) return () => {};
  const stream = openEventStream({
    baseUrl: apiBaseUrl(),
    token: () => session.store.get(),
    refresh: () => session.api.refresh(),
    onEvent,
    EventSourceImpl: Impl,
  });
  return () => stream.close();
}

class Live {
  unread = $state(0);
  EventSourceImpl: typeof EventSource | undefined = undefined;

  connect(session: Session): () => void {
    const close = eventStream(session, (e) => this.#handle(e), { EventSourceImpl: this.EventSourceImpl });
    return () => {
      close();
      this.unread = 0;
    };
  }

  #pending: Set<string> | null = null;

  #stale(keys: readonly string[]): void {
    if (!this.#pending) {
      const due = new Set<string>();
      this.#pending = due;
      setTimeout(() => {
        this.#pending = null;
        for (const key of due) void cache.invalidate([key], { passive: true });
      }, 0);
    }
    for (const key of keys) this.#pending.add(key);
  }

  #handle(e: StreamEvent): void {
    if (e.type === 'unread') {
      const count = (e.data as { count?: unknown } | null)?.count;
      if (typeof count === 'number' && count >= 0) this.unread = count;
    } else if (e.type === 'notification') {
      const n = e.data as ApiNotification;
      const payload = (n.payload ?? {}) as Record<string, unknown>;
      toasts.push({
        tone: 'neutral',
        text: notificationMessage(n.type, payload, 'title', t),
        detail: notificationMessage(n.type, payload, 'body', t),
      });
      this.#stale(['notifications', ...(LIVE_KEYS[n.type] ?? [])]);
    }
  }
}

const LIVE_KEYS: Record<string, readonly string[]> = {
  RECALL: ['recalls', 'recall', 'recallTasks', 'batches', 'batch', 'dashboard'],
  RECALL_TASK: ['recallTasks', 'recall', 'recalls', 'dashboard'],
  OVERDUE: ['recallTasks', 'recall', 'recalls', 'dashboard'],
  COMPLAINT: ['complaints', 'complaint', 'dashboard'],
  LAB_ASSIGNED: ['labTests', 'labTest', 'dashboard'],
  LAB_RESULT: ['labTests', 'labTest', 'batches', 'batch', 'dashboard'],
  LAB_OVERDUE: ['labTests', 'labTest', 'dashboard'],
  WAYBILL_INCOMING: ['waybills', 'waybill', 'dashboard'],
};

export const live = new Live();

export function bellCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}
