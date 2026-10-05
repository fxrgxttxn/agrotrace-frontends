import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach } from 'vitest';
import { AppProviders, createQueryClient } from '../../src/app/providers';
import { buildRoutes, ROUTER_FUTURE } from '../../src/app/router';
import { createSessionCore, type SessionCore } from '../../src/app/session';

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1);
  }
  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown, lastEventId = ''): void {
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

const cores: SessionCore[] = [];
afterEach(() => {
  for (const c of cores.splice(0)) c.api.dispose();
  FakeEventSource.instances = [];
});

export function renderApp(path: string) {
  const core = createSessionCore();
  cores.push(core);
  const router = createMemoryRouter(buildRoutes(core, FakeEventSource as unknown as typeof EventSource), {
    initialEntries: [path],
    future: ROUTER_FUTURE,
  });
  const utils = render(
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>,
  );
  return { ...utils, router, core };
}
