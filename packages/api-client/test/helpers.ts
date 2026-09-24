// Shared test doubles: fetch/Response builders, and minimal mocks of the three browser APIs the
// client depends on for cross-tab coordination (navigator.locks, BroadcastChannel) and streaming
// (EventSource) — none of which exist in a plain Node vitest environment.

/** The client always calls its injected `fetch` with a single, fully-built `Request` (matching how
 * openapi-fetch and real browsers call `fetch(request)`) — these read whichever shape shows up. */
export function requestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  return input instanceof Request ? input.headers : new Headers(init?.headers);
}

export function requestCredentials(
  input: string | URL | Request,
  init?: RequestInit,
): RequestCredentials | undefined {
  return input instanceof Request ? input.credentials : init?.credentials;
}

export function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
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

/** Resolves with `value` after `ms` — for building fetch mocks where different requests (e.g. two
 * tabs' concurrent /auth/refresh calls) resolve at different, explicit times. Pairs with fake
 * timers (`vi.advanceTimersByTimeAsync`). */
export function afterMs<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
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
      // Real BroadcastChannel delivery is a separate task (macrotask), never synchronous or even
      // a same-microtask-turn callback — scheduling via setTimeout(0) instead of calling straight
      // through catches bugs that only show up once other same-tick code (like our own pending
      // fetch) has had a chance to run first. Plays nicely with `vi.advanceTimersByTimeAsync`.
      setTimeout(() => {
        if (peer.closed) return;
        for (const listener of peer.listeners) listener({ data } as MessageEvent);
      }, 0);
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

/** Minimal EventSource stand-in: exposes the same `addEventListener`/`onerror`/`onopen`/`close`/
 * `readyState` surface `openEventStream` uses, plus test-only `emit`/`fail`/`transientError`/`open`
 * helpers to drive it from a test. Mirrors the real readyState machine (CONNECTING/OPEN/CLOSED) —
 * that distinction is exactly what Important 4 (dead SSE after CLOSED) hinges on. */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = MockEventSource.CONNECTING;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  get closed(): boolean {
    return this.readyState === MockEventSource.CLOSED;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Matches the real API: closing never itself fires `onerror`. */
  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  /** Simulates the server accepting the connection. */
  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId?: string): void {
    const event = { data: JSON.stringify(data), lastEventId: lastEventId ?? '' } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Simulates a fatal failure: the server rejected the (re)connection outright (typically an
   * expired/invalid token on connect) and the browser gives up — readyState becomes CLOSED and
   * stays there, so nothing will happen again without intervention. */
  fail(event: Event = new Event('error')): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(event);
  }

  /** Simulates a transient network blip the browser is still auto-retrying on its own —
   * readyState goes back to CONNECTING, not CLOSED. */
  transientError(event: Event = new Event('error')): void {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.(event);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}
