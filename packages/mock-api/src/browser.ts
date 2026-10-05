import { setupWorker } from 'msw/browser';
import { createMockApi, type MockApi, type MockApiOptions } from './index.js';

export interface BrowserMockOptions extends MockApiOptions {
  serviceWorkerUrl?: string;
  quiet?: boolean;
}

export async function startBrowserMock(options: BrowserMockOptions = {}): Promise<MockApi> {
  const api = createMockApi({ delayMs: 120, ...options });
  const worker = setupWorker(...api.handlers);
  await worker.start({
    serviceWorker: { url: options.serviceWorkerUrl ?? '/mockServiceWorker.js' },
    onUnhandledRequest: 'bypass',
    quiet: options.quiet ?? true,
  });
  await api.ready;
  (globalThis as { __agrotraceMock?: MockApi }).__agrotraceMock = api;
  return api;
}
