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
import { useScreenScope } from './cache';
import { runPassive } from './actions';

const UnreadContext = createContext<{ count: number; set: (count: number) => void }>({
  count: 0,
  set: () => {},
});

export function useUnread(): number {
  return useContext(UnreadContext).count;
}

export function useSetUnread(): (count: number) => void {
  const set = useContext(UnreadContext).set;
  const { sameSession } = useScreenScope();
  return useCallback((count: number) => void (sameSession() && set(count)), [set, sameSession]);
}

export interface EventSourceOptions {
  EventSourceImpl?: typeof EventSource;
}

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
        stale.mark(queryClient, ['notifications', ...(LIVE_KEYS[n.type] ?? [])]);
      }
    },
    { EventSourceImpl },
  );

  const value = useMemo(() => ({ count: unread, set: setUnread }), [unread]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
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

const stale = (() => {
  const pending = new Map<QueryClient, Set<string>>();
  return {
    mark(client: QueryClient, keys: readonly string[]) {
      let set = pending.get(client);
      if (!set) {
        set = new Set();
        pending.set(client, set);
        setTimeout(() => {
          const due = pending.get(client);
          pending.delete(client);
          for (const key of due ?? []) invalidateEvenInFlight(client, [key]);
        }, 0);
      }
      for (const k of keys) set.add(k);
    },
  };
})();

export function invalidateEvenInFlight(client: QueryClient, queryKey: QueryKey): void {
  const inFlight = client
    .getQueryCache()
    .findAll({ queryKey })
    .filter(
      (q) =>
        q.state.fetchStatus === 'fetching' && (q.getObserversCount() === 0 || q.state.data === undefined),
    );
  runPassive(() => void client.invalidateQueries({ queryKey }));
  for (const q of inFlight)
    void q.promise?.finally(() =>
      runPassive(() => void client.invalidateQueries({ queryKey: q.queryKey, exact: true })),
    );
}
