export type StreamEventType = 'notification' | 'unread' | 'reauth';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  id?: string;
}

export interface OpenEventStreamOptions {
  baseUrl?: string;
  token: () => string | null;
  onEvent: (event: StreamEvent) => void;
  onError?: (event: Event) => void;
  refresh: () => Promise<string | null>;
  EventSourceImpl?: typeof EventSource;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_CONSECUTIVE_FAILURES = 10;

export function openEventStream(opts: OpenEventStreamOptions): { close(): void } {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const EventSourceCtor = opts.EventSourceImpl ?? EventSource;

  let source: EventSource | null = null;
  let lastEventId: string | undefined;
  let closed = false;
  let reconnecting = false;
  let backoffIndex = 0;
  let consecutiveFailures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function buildUrl(): string {
    const params = new URLSearchParams({ access_token: opts.token() ?? '' });
    if (lastEventId) params.set('lastEventId', lastEventId);
    return `${baseUrl}/events/stream?${params.toString()}`;
  }

  function forward(type: StreamEventType) {
    return (event: MessageEvent<string>) => {
      if (event.lastEventId) lastEventId = event.lastEventId;
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        data = event.data;
      }
      opts.onEvent({ type, data, id: event.lastEventId || undefined });
    };
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function afterFailedAttempt(triggerEvent: Event): void {
    if (closed) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      opts.onError?.(triggerEvent);
      return;
    }
    scheduleReconnect(triggerEvent);
  }

  function scheduleReconnect(triggerEvent: Event): void {
    if (closed || reconnecting || reconnectTimer !== null) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)]!;
    backoffIndex = Math.min(backoffIndex + 1, RECONNECT_BACKOFF_MS.length - 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnectViaRefresh(triggerEvent);
    }, delay);
  }

  async function reconnectViaRefresh(triggerEvent: Event): Promise<void> {
    if (reconnecting || closed) return;
    reconnecting = true;
    let failed = false;
    try {
      const newToken = await opts.refresh();
      if (closed) return;
      if (newToken) {
        attach();
      } else {
        opts.onError?.(triggerEvent);
      }
    } catch {
      failed = true;
    } finally {
      reconnecting = false;
    }
    if (failed) afterFailedAttempt(triggerEvent);
  }

  function attach(): void {
    if (closed) return;
    clearReconnectTimer();
    const es = new EventSourceCtor(buildUrl());
    source = es;

    es.addEventListener('notification', forward('notification') as EventListener);
    es.addEventListener('unread', forward('unread') as EventListener);
    es.addEventListener('reauth', ((event: MessageEvent<string>) => {
      es.close();
      if (source === es) source = null;
      clearReconnectTimer();
      void reconnectViaRefresh(event);
    }) as EventListener);
    es.onopen = () => {
      backoffIndex = 0;
      consecutiveFailures = 0;
    };
    es.onerror = (event) => {
      opts.onError?.(event);
      if (es.readyState === EventSourceCtor.CLOSED) {
        afterFailedAttempt(event);
      }
    };
  }

  attach();

  return {
    close(): void {
      closed = true;
      clearReconnectTimer();
      source?.close();
      source = null;
    },
  };
}
