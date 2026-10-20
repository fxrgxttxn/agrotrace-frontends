import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, inject, vi } from 'vitest';
import { contractHandlers, loadContract } from './msw/fromContract';

// jsdom gaps the app relies on: <dialog> modal API, matchMedia, scrollIntoView, EventSource (replaced per test).
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
// Object URLs (image previews): jsdom has none.
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

// Lazy page chunks are transformed on first use: the first screen of a file may need several seconds on a busy host.
configure({ asyncUtilTimeout: 10000 });

loadContract(inject('contract'));

export const server = setupServer(...contractHandlers());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  server.resetHandlers();
});
afterAll(() => server.close());

// ECharts draws into an SVG sized by layout (jsdom has none): every test gets a recording stand-in; the dashboard tests
// check what the page hands to it (the bars), the options themselves are tested in test/app/charts.test.ts.
vi.mock('../src/charts/echarts', () => ({
  mountBars: vi.fn(() => ({ destroy: () => {} })),
}));
