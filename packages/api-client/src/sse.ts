export type StreamEventType = 'notification' | 'unread' | 'reauth';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  id?: string;
}

export interface OpenEventStreamOptions {
  /** Default `/api/v1`, matching `servers` in contracts/openapi.yaml. */
  baseUrl?: string;
  /** Reads the current access token; EventSource cannot send headers, so it goes in the
   * `access_token` query param (contracts/openapi/paths/events.yaml). */
  token: () => string | null;
  onEvent: (event: StreamEvent) => void;
  onError?: (event: Event) => void;
  /** R33: on `reauth` (and, per Important 4, on a dead CLOSED connection), the stream must be
   * closed, the token refreshed, and a new stream opened with the new `access_token` — this is the
   * passed-in api's single-flight refresh ({@link Api.refresh}), so a concurrent REST 401 and an
   * SSE reconnect share one refresh call. */
  refresh: () => Promise<string | null>;
  /** Injectable for tests; defaults to the global `EventSource`. */
  EventSourceImpl?: typeof EventSource;
}

/** Delay before each successive refresh-and-reattach attempt once the connection has gone
 * CLOSED without an explicit `reauth` (e.g. an expired token rejected outright on connect) —
 * capped at 30s so a prolonged outage doesn't hammer the server. Reset to the first delay as soon
 * as a connection successfully opens. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Opens the `GET /events/stream` SSE connection and manages reconnection:
 * - `reauth` (server-initiated): close immediately (so the browser doesn't auto-reconnect with the
 *   stale token), refresh, and reopen with the new `access_token` and `lastEventId` — no backoff,
 *   this is a deterministic signal, not a failure.
 * - readyState reaching CLOSED without a `reauth` (Important 4: e.g. the initial connection, or a
 *   native reconnect, was rejected outright — typically an already-expired token) — the browser
 *   will not retry on its own once CLOSED, so this refreshes and re-attaches itself, with bounded
 *   exponential backoff, stopping (and surfacing `onError`) once `refresh()` returns `null`.
 * - any other error (readyState still CONNECTING) is a transient network hiccup the browser is
 *   already retrying — only forwarded to `onError`, no action taken here.
 */
export function openEventStream(opts: OpenEventStreamOptions): { close(): void } {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const EventSourceCtor = opts.EventSourceImpl ?? EventSource;

  let source: EventSource | null = null;
  let lastEventId: string | undefined;
  let closed = false;
  let reconnecting = false;
  let backoffIndex = 0;
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

  /** Shared by both the `reauth` path and the CLOSED-backoff path — guarded by `reconnecting` so
   * the two can never race into opening two EventSources at once. */
  async function reconnectViaRefresh(triggerEvent: Event): Promise<void> {
    if (reconnecting || closed) return;
    reconnecting = true;
    try {
      const newToken = await opts.refresh();
      if (closed) return;
      if (newToken) {
        // Backoff resets only on a successful *open* (see `es.onopen` in `attach`) — merely
        // getting a new token and re-attaching doesn't prove the connection is actually good; the
        // new EventSource may itself immediately fail again.
        attach();
      } else {
        // refresh() already ran onAuthLost and cleared the store — surface it, don't reconnect.
        opts.onError?.(triggerEvent);
      }
    } finally {
      reconnecting = false;
    }
  }

  function scheduleClosedReconnect(triggerEvent: Event): void {
    if (closed || reconnecting || reconnectTimer !== null) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)]!;
    backoffIndex = Math.min(backoffIndex + 1, RECONNECT_BACKOFF_MS.length - 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnectViaRefresh(triggerEvent);
    }, delay);
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
    };
    es.onerror = (event) => {
      opts.onError?.(event);
      if (es.readyState === EventSourceCtor.CLOSED) {
        scheduleClosedReconnect(event);
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
