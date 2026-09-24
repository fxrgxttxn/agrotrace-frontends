// Shared test doubles: fetch/Response builders, and minimal mocks of the three browser APIs the
// client depends on for cross-tab coordination (navigator.locks, BroadcastChannel) and streaming
// (EventSource) — none of which exist in a plain Node vitest environment.

/** The client always calls its injected `fetch` with a single, fully-built `Request` (matching how
 * openapi-fetch and real browsers call `fetch(request)`) — these read whichever shape shows up. */
export function requestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  return input instanceof Request ? input.headers : new Headers(init?.headers);
}

export function requestCredentials(input: string | URL | Request, init?: RequestInit): RequestCredentials | undefined {
  return input instanceof Request ? input.credentials : init?.credentials;
}

export function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

export function problemResponse(
  body: { code: string; type?: string; title?: string; [key: string]: unknown },
  status: number,
  headers: Record<string, string> = {},
): Response {
  const full = { type: `/problems/${body.code.toLowerCase().replace(/_/g, '-')}`, title: body.code, ...body };
  return new Response(JSON.stringify(full), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

export function noContentResponse(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/** Real Web Locks serialize callbacks requested under the same name, one at a time, in request
 * order — this reproduces that ordering without any actual browser lock. */
export class MockLockManager {
  private chains = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const settleFirst = prev.then(
      () => undefined,
      () => undefined,
    );
    const result = settleFirst.then(callback);
    this.chains.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

/** BroadcastChannel instances that share a `name` deliver messages to every *other* instance of
 * that name (never back to the sender) — this mock reproduces that across a whole test file via a
 * module-level registry, so two `createApi()` calls can stand in for two browser tabs. */
export class MockBroadcastChannel {
  private static registry = new Map<string, Set<MockBroadcastChannel>>();
  private listeners = new Set<(event: MessageEvent) => void>();
  private closed = false;

  constructor(private readonly name: string) {
    const set = MockBroadcastChannel.registry.get(name) ?? new Set();
    set.add(this);
    MockBroadcastChannel.registry.set(name, set);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const peers = MockBroadcastChannel.registry.get(this.name) ?? new Set();
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      for (const listener of peer.listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
    MockBroadcastChannel.registry.get(this.name)?.delete(this);
  }

  static reset(): void {
    MockBroadcastChannel.registry.clear();
  }
}

/** Minimal EventSource stand-in: exposes the same `addEventListener`/`onerror`/`close` surface
 * `openEventStream` uses, plus test-only `emit`/`fail` helpers to drive it from a test. */
export class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown, lastEventId?: string): void {
    const event = { data: JSON.stringify(data), lastEventId: lastEventId ?? '' } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(event: Event = new Event('error')): void {
    this.onerror?.(event);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}
