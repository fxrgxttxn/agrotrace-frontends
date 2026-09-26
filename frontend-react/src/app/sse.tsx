import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { apiBaseUrl, useSession } from './session';
import { useToast } from '../ui/Toasts';
import { useScreenAlive } from './cache';

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

/** Sets the counter from an answer that carries it (`UnreadCount` of `POST /notifications/read`) — bound to the
 * screen and its session (FM25/FM26): a late answer after sign-out or after leaving the screen does not touch the bell. */
export function useSetUnread(): (count: number) => void {
  const set = useContext(UnreadContext).set;
  const alive = useScreenAlive();
  return useCallback((count: number) => void (alive() && set(count)), [set, alive]);
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
        invalidateEvenInFlight(queryClient, ['notifications']);
      }
    },
    { EventSourceImpl },
  );

  const value = useMemo(() => ({ count: unread, set: setUnread }), [unread]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

/** Invalidates the lists; a fetch already on its way began before the event, so its answer is marked stale when it
 * arrives (FM25) — shown now, asked again on the next view (at once if on screen). */
export function invalidateEvenInFlight(client: QueryClient, queryKey: QueryKey): void {
  const inFlight = client
    .getQueryCache()
    .findAll({ queryKey })
    // Queries on screen are refetched by the invalidation itself (the running fetch is replaced); the others keep
    // their running fetch, whose answer must not count as fresh.
    .filter((q) => q.state.fetchStatus === 'fetching' && q.getObserversCount() === 0);
  void client.invalidateQueries({ queryKey });
  for (const q of inFlight)
    void q.promise?.finally(() => void client.invalidateQueries({ queryKey: q.queryKey, exact: true }));
}
