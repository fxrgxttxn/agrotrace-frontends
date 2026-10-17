import type { ClientInit, HandleClientError } from '@sveltejs/kit';
import { base } from '$app/paths';
import { CHUNK_FAILED, isChunkError, noteChunkFailure } from '$lib/app/chunkFailure';
import { stripBase } from '$lib/app/paths';
import { earlyBatchUrl, startEarly } from '$lib/public/early';

export const init: ClientInit = async () => {
  if (import.meta.env.MODE === 'mock') {
    const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
    await startBrowserMock({
      serviceWorkerUrl: `${base}/mockServiceWorker.js`,
      publicBaseUrl: `${location.origin}${base}`,
    });
  }
  const early = earlyBatchUrl(stripBase(location.pathname), location.origin);
  if (early) startEarly(early);
};

export const handleError: HandleClientError = ({ error }) => {
  if (isChunkError(error)) {
    noteChunkFailure();
    return { message: CHUNK_FAILED };
  }
  console.error(error);
  return { message: 'error' };
};
