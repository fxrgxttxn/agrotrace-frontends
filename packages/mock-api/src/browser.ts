import { setupWorker } from 'msw/browser';
import { createMockApi, type MockApi, type MockApiOptions } from './index.js';

export interface BrowserMockOptions extends MockApiOptions {
  serviceWorkerUrl?: string;
  quiet?: boolean;
}

export async function startBrowserMock(options: BrowserMockOptions = {}): Promise<MockApi> {
  const url = options.serviceWorkerUrl ?? '/mockServiceWorker.js';
  const scope = new URL('.', new URL(url, location.href)).pathname;
  const api = createMockApi({ delayMs: 120, namespace: scope === '/' ? undefined : scope, ...options });
  const worker = setupWorker(...api.handlers);
  await worker.start({
    serviceWorker: { url },
    onUnhandledRequest: 'bypass',
    quiet: options.quiet ?? true,
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'MOCK_REVIVE')
      (event.source as ServiceWorker | null)?.postMessage('MOCK_ACTIVATE');
  });
  await api.ready;
  (globalThis as { __agrotraceMock?: MockApi }).__agrotraceMock = api;
  return api;
}
