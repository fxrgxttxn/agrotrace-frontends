import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { apiBaseUrl, useSession } from './session';
import { useToast } from '../ui/Toasts';

// Live notifications (spec §9.2 «useEventSource», rulings R33/R63): while signed in, one `GET /events/stream` through
// api-client's openEventStream — `reauth` and dead connections refresh through the same single-flight refresh as
// REST calls. `unread` sets the bell counter; `notification` shows a toast and refreshes the notification lists.

const UnreadContext = createContext<{ count: number; set: (count: number) => void }>({
  count: 0,
  set: () => {},
});

/** Unread notifications (bell counter): from SSE `unread`, or from a `markNotificationsRead` answer. */
export function useUnread(): number {
  return useContext(UnreadContext).count;
}

/** Sets the counter from an answer that carries it (`UnreadCount` of `POST /notifications/read`). */
export function useSetUnread(): (count: number) => void {
  return useContext(UnreadContext).set;
}

export interface EventSourceOptions {
  EventSourceImpl?: typeof EventSource;
}

/** Opens the stream while `enabled`, calls `onEvent` for each event; closes on disable/unmount. */
export function useEventSource(
  enabled: boolean,
  onEvent: (e: StreamEvent) => void,
  { EventSourceImpl }: EventSourceOptions = {},
): void {
  const { api, store } = useSession();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    const Impl = EventSourceImpl ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
    if (!Impl) return;
    const stream = openEventStream({
      baseUrl: apiBaseUrl(),
      token: () => store.get(),
      refresh: () => api.refresh(),
      onEvent: (e) => handler.current(e),
      EventSourceImpl: Impl,
    });
    return () => stream.close();
  }, [enabled, api, store, handler, EventSourceImpl]);
}

export function LiveEventsProvider({
  children,
  EventSourceImpl,
}: { children: ReactNode } & EventSourceOptions) {
  const { state } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [unread, setUnread] = useState(0);
  const signedIn = state.status === 'authenticated';

  useEffect(() => {
    if (!signedIn) setUnread(0);
  }, [signedIn]);

  useEventSource(
    signedIn,
    (e) => {
      if (e.type === 'unread') {
        const count = (e.data as { count?: unknown } | null)?.count;
        if (typeof count === 'number' && count >= 0) setUnread(count);
      } else if (e.type === 'notification') {
        const n = e.data as ApiNotification;
        const payload = (n.payload ?? {}) as Record<string, unknown>;
        toast.push({
          tone: 'neutral',
          text: notificationMessage(n.type, payload, 'title', t),
          detail: notificationMessage(n.type, payload, 'body', t),
        });
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      }
    },
    { EventSourceImpl },
  );

  const value = useMemo(() => ({ count: unread, set: setUnread }), [unread]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
