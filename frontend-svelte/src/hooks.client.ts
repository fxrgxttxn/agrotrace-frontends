import type { ClientInit, HandleClientError } from '@sveltejs/kit';
import { CHUNK_FAILED, isChunkError, noteChunkFailure } from '$lib/app/chunkFailure';

// Mock mode (ruling FM23, `vite build --mode mock` → build-mock): the in-browser backend of @agrotrace/mock-api (MSW
// service worker) answers /api/v1 before the app's first request — SvelteKit awaits `init` before it starts. The
// production build never contains it: MODE is a build-time constant, the branch and its dynamic import are dropped.
export const init: ClientInit = async () => {
  if (import.meta.env.MODE !== 'mock') return;
  const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
  await startBrowserMock();
};

// Errors while loading a route (never a raw framework error): a page chunk that cannot be loaded is marked for the
// FM11/FM15 recovery (decided when the failed navigation commits: lib/app/chunkFailure.ts); the route group's
// +error.svelte shows the failure state otherwise.
export const handleError: HandleClientError = ({ error }) => {
  if (isChunkError(error)) {
    noteChunkFailure();
    return { message: CHUNK_FAILED };
  }
  console.error(error);
  return { message: 'error' };
};
