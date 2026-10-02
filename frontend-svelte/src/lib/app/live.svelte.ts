import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { cache } from './cache.svelte';
import { t } from './i18n';
import { apiBaseUrl, type Session } from './session.svelte';
import { toasts } from '../ui/toast-store.svelte';

// Live notifications (spec §9.2 «стор-обёртка над EventSource», rulings R33/R63): while signed in, one
// `GET /events/stream` through api-client's openEventStream — `reauth` and dead connections refresh through the same
// single-flight refresh as REST calls. `unread` sets the bell counter; `notification` shows a toast and marks the
// notification lists stale. Same behaviour as the React app (src/app/sse.tsx there).

export interface StreamOptions {
  EventSourceImpl?: typeof EventSource;
}

/** Opens the stream of `session`, calls `onEvent` for each event; the returned function closes it. */
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
  /** Unread notifications (bell counter): from SSE `unread`, or from a `markNotificationsRead` answer. */
  unread = $state(0);
  /** Tests replace the browser's EventSource. */
  EventSourceImpl: typeof EventSource | undefined = undefined;

  /** Runs the stream for a signed-in session; the returned function stops it and resets the counter. */
  connect(session: Session): () => void {
    const close = eventStream(session, (e) => this.#handle(e), { EventSourceImpl: this.EventSourceImpl });
    return () => {
      close();
      this.unread = 0;
    };
  }

  /** Keys made stale by the events of one task, invalidated together once the task ends (each key once). */
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
      // the screens the notification is about read again (a live refresh never moves the focus, FM30)
      this.#stale(['notifications', ...(LIVE_KEYS[n.type] ?? [])]);
    }
  }
}

/** Cache keys a notification type makes stale (besides the notification lists): the lists, the cards and the
 * dashboard it is about (as the React app's LIVE_KEYS, src/app/sse.tsx there). */
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

/** Bell counter text: none at 0, «99+» above 99 (README «Шапка»). */
export function bellCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}
