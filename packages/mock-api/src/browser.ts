/**
 * Browser entry: registers the MSW service worker (copy `public/mockServiceWorker.js` of this package into the
 * frontend's public dir) and serves `/api/v1/*` from the mock. Requests outside `/api/v1` pass through.
 *
 *   if (import.meta.env.MODE === 'mock') {
 *     const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
 *     await startBrowserMock();
 *   }
 */
import { setupWorker } from 'msw/browser';
import { createMockApi, type MockApi, type MockApiOptions } from './index.js';

export interface BrowserMockOptions extends MockApiOptions {
  /** URL of the worker script (default `/mockServiceWorker.js`). */
  serviceWorkerUrl?: string;
  /** Silence MSW's console messages (default true). */
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
