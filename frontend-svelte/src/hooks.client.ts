import type { HandleClientError } from '@sveltejs/kit';
import { armReload, isChunkError } from '$lib/app/chunkFailure';

// Errors while loading a route (never a raw framework error): a page chunk that cannot be loaded gets one full-document
// load (FM11, started by the root layout once the error page is committed); the route group's +error.svelte shows the
// failure state otherwise.
export const handleError: HandleClientError = ({ error, event }) => {
  if (isChunkError(error)) return { message: armReload(event.url) ? 'reloading' : 'chunk' };
  console.error(error);
  return { message: 'error' };
};
