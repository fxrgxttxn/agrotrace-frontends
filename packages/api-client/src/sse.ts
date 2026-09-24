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
  /** R33: on `reauth`, the stream must be closed, the token refreshed, and a new stream opened
   * with the new `access_token` — this is the passed-in api's single-flight refresh
   * ({@link Api.refresh}), so a concurrent REST 401 and an SSE `reauth` share one refresh call. */
  refresh: () => Promise<string | null>;
  /** Injectable for tests; defaults to the global `EventSource`. */
  EventSourceImpl?: typeof EventSource;
}

/** Opens the `GET /events/stream` SSE connection and manages the R33 reauth protocol: on the
 * server's `reauth` event, closes the EventSource (so the browser doesn't auto-reconnect with the
 * stale token), refreshes, and reopens with the new `access_token` and `lastEventId` (the `seq` of
 * the last `notification` event received). Network errors are left to EventSource's own
 * auto-reconnect — only `reauth` triggers a manual close/reopen. */
export function openEventStream(opts: OpenEventStreamOptions): { close(): void } {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const EventSourceCtor = opts.EventSourceImpl ?? EventSource;

  let source: EventSource | null = null;
  let lastEventId: string | undefined;
  let closed = false;

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

  async function handleReauth(event: MessageEvent<string>): Promise<void> {
    // Close first — an EventSource left open would otherwise auto-reconnect with the stale token.
    source?.close();
    source = null;
    if (closed) return;

    const newToken = await opts.refresh();
    if (closed) return;

    if (newToken) {
      attach();
    } else {
      // refresh() already ran onAuthLost; surface it as a stream error rather than reconnecting.
      opts.onError?.(event);
    }
  }

  function attach(): void {
    if (closed) return;
    const es = new EventSourceCtor(buildUrl());
    source = es;

    es.addEventListener('notification', forward('notification') as EventListener);
    es.addEventListener('unread', forward('unread') as EventListener);
    es.addEventListener('reauth', ((event: MessageEvent<string>) => {
      void handleReauth(event);
    }) as EventListener);
    es.onerror = (event) => {
      opts.onError?.(event);
    };
  }

  attach();

  return {
    close(): void {
      closed = true;
      source?.close();
      source = null;
    },
  };
}
