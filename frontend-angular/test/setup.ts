import '@angular/compiler';
import '@analogjs/vitest-angular/setup-zone';
import '@testing-library/jest-dom/vitest';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { configure } from '@testing-library/dom';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, inject, vi } from 'vitest';
import { contractHandlers, loadContract } from './msw/fromContract';

getTestBed().initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
  teardown: { destroyAfterEach: true },
});

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

configure({ asyncUtilTimeout: 8000 });

loadContract(inject('contract'));

export const server = setupServer(...contractHandlers());

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  server.resetHandlers();
});
afterAll(() => server.close());

vi.mock('../src/charts/echarts', () => ({
  mountBars: vi.fn(() => ({ destroy: () => {} })),
}));
