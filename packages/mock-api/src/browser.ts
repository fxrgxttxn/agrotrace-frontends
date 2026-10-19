/**
 * Browser entry: registers the MSW service worker (copy `public/` of this package — `mockServiceWorker.js` and
 * `msw/` — into the frontend's public dir) and serves `/api/v1/*` from the mock. Requests outside `/api/v1` pass
 * through.
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
  // A new worker version (a deploy that changed public/) taking over this already controlled tab: MSW stays bound to
  // the old worker and would ignore the new one's messages, so the tab reloads once under the new worker.
  const previous = navigator.serviceWorker.controller;
  if (previous)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (navigator.serviceWorker.controller !== previous) location.reload();
    });
  await worker.start({
    serviceWorker: { url: options.serviceWorkerUrl ?? '/mockServiceWorker.js' },
    onUnhandledRequest: 'bypass',
    quiet: options.quiet ?? true,
  });
  // A restarted worker (Chrome stops an idle one) has forgotten this tab; public/mockServiceWorker.js asks the tab
  // with MOCK_REVIVE before its first request and the tab activates mocking again.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'MOCK_REVIVE')
      (event.source as ServiceWorker | null)?.postMessage('MOCK_ACTIVATE');
  });
  await api.ready;
  (globalThis as { __agrotraceMock?: MockApi }).__agrotraceMock = api;
  return api;
}
