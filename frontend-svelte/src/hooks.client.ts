import type { ClientInit, HandleClientError } from '@sveltejs/kit';
import { CHUNK_FAILED, isChunkError, noteChunkFailure } from '$lib/app/chunkFailure';
import { earlyBatchUrl, startEarly } from '$lib/public/early';

export const init: ClientInit = async () => {
  if (import.meta.env.MODE === 'mock') {
    const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
    await startBrowserMock();
  }
  const early = earlyBatchUrl(location.pathname, location.origin);
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
