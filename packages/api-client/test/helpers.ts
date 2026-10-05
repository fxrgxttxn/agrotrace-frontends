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

export function afterMs<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

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

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId?: string): void {
    const event = { data: JSON.stringify(data), lastEventId: lastEventId ?? '' } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(event: Event = new Event('error')): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(event);
  }

  transientError(event: Event = new Event('error')): void {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.(event);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}
