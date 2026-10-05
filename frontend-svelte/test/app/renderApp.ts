import { render } from '@testing-library/svelte';
import { afterEach } from 'vitest';
import { cache } from '../../src/lib/app/cache.svelte';
import { live } from '../../src/lib/app/live.svelte';
import { resetRouteFocus } from '../../src/lib/app/routeFocus';
import { resetSession, session } from '../../src/lib/app/session.svelte';
import { toasts } from '../../src/lib/ui/toast-store.svelte';
import App from '../kit/App.svelte';
import { router } from '../kit/router.svelte';

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

afterEach(() => {
  router.reset();
  session.dispose();
  toasts.reset();
  FakeEventSource.instances = [];
});

export async function renderApp(path: string) {
  router.reset();
  resetRouteFocus();
  toasts.reset();
  cache.clear();
  live.EventSourceImpl = FakeEventSource as unknown as typeof EventSource;
  const s = resetSession();
  history.replaceState(null, '', '/');
  document.body.setAttribute('data-sveltekit-keepfocus', '');
  const utils = render(App);
  await router.start(path);
  return { ...utils, router, session: s };
}
