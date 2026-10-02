import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/svelte';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, inject, vi } from 'vitest';
import { contractHandlers, loadContract } from './msw/fromContract';

// The same jsdom set-up as the React app (frontend-react/test/setup.ts): <dialog> modal API, matchMedia,
// scrollIntoView, object URLs, Web Locks; MSW handlers generated from the contract answer every /api/v1 call.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
window.scrollTo = () => {};
let objectUrls = 0;
URL.createObjectURL ??= () => `blob:http://localhost/${++objectUrls}`;
URL.revokeObjectURL ??= () => {};
// Web Locks (every supported browser has them; jsdom not): an exclusive in-memory lock per name, so api-client runs
// the same refresh path as in a browser (no 10 s cross-tab grace wait, R32).
if (!('locks' in navigator)) {
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    value: {
      request<T>(name: string, cb: () => Promise<T> | T): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(() => cb());
        tails.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    },
  });
}

configure({ asyncUtilTimeout: 4000 });

loadContract(inject('contract'));

export const server = setupServer(...contractHandlers());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  server.resetHandlers();
});
afterAll(() => server.close());

// ECharts is replaced (as in the React app's set-up): tests check the bars a page hands to it and the canvas summary.
vi.mock('../src/lib/charts/echarts', () => ({
  mountBars: vi.fn(() => ({ destroy: () => {} })),
}));
