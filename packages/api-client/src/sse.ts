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

/** Delay before each successive reconnect attempt after a failure (a CLOSED connection, or —
 * R63 — a transient `refresh()` rejection) — capped at 30s so a prolonged outage doesn't hammer the
 * server. Reset to the first delay as soon as a connection successfully opens. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/** R63: give up (surface `onError`, stop retrying) after this many consecutive failed attempts —
 * CLOSED connections and/or rejected `refresh()` calls — that never reach a successful open. Reset
 * on `es.onopen`, same as the backoff. */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Opens the `GET /events/stream` SSE connection and manages reconnection:
 * - `reauth` (server-initiated): close immediately (so the browser doesn't auto-reconnect with the
 *   stale token) and refresh — no backoff *before* this first attempt, it's a deterministic signal,
 *   not a failure — then reopen with the new `access_token` and `lastEventId`.
 * - readyState reaching CLOSED without a `reauth` (Important 4: e.g. the initial connection, or a
 *   native reconnect, was rejected outright — typically an already-expired token) — the browser
 *   will not retry on its own once CLOSED, so this refreshes and re-attaches itself, with bounded
 *   exponential backoff.
 * - a `refresh()` call itself rejecting (R63: a *transient* failure — a 5xx or network error from
 *   `/auth/refresh`, entirely normal per R61, e.g. during a backend restart) is treated the same as
 *   a failed connection attempt: scheduled for retry with backoff, not left to become an unhandled
 *   rejection that kills the stream for good.
 * - either kind of failure, repeated {@link MAX_CONSECUTIVE_FAILURES} times in a row with no
 *   successful open in between, gives up and surfaces `onError` instead of retrying indefinitely.
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

  /** Records a failed attempt (CLOSED connection or rejected refresh) and either schedules the
   * next one with backoff, or — past {@link MAX_CONSECUTIVE_FAILURES} — gives up for good. */
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

  /** Shared by the `reauth` path and the backoff-scheduled retry path — guarded by `reconnecting`
   * so the two can never race into opening two EventSources at once. R63: a rejection from
   * `opts.refresh()` (transient per R61) is caught and treated as a failed attempt — scheduled for
   * retry — rather than becoming an unhandled rejection that leaves the stream dead. */
  async function reconnectViaRefresh(triggerEvent: Event): Promise<void> {
    if (reconnecting || closed) return;
    reconnecting = true;
    let failed = false;
    try {
      const newToken = await opts.refresh();
      if (closed) return;
      if (newToken) {
        // Backoff/failure count resets only on a successful *open* (see `es.onopen` in `attach`)
        // — merely getting a new token and re-attaching doesn't prove the connection is actually
        // good; the new EventSource may itself immediately fail again.
        attach();
      } else {
        // refresh() already ran onAuthLost and cleared the store — surface it, don't reconnect.
        opts.onError?.(triggerEvent);
      }
    } catch {
      failed = true;
    } finally {
      reconnecting = false;
    }
    // Scheduling happens after `reconnecting` is reset above — `scheduleReconnect` itself guards
    // against `reconnecting`, which would otherwise always be true here.
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
