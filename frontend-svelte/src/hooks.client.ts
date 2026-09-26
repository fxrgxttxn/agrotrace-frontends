import type { HandleClientError } from '@sveltejs/kit';
import { CHUNK_FAILED, isChunkError } from '$lib/app/chunkFailure';

// Errors while loading a route (never a raw framework error): a page chunk that cannot be loaded is marked for the
// FM11/FM15 recovery (decided when the failed navigation commits: lib/app/chunkFailure.ts); the route group's
// +error.svelte shows the failure state otherwise.
export const handleError: HandleClientError = ({ error }) => {
  if (isChunkError(error)) return { message: CHUNK_FAILED };
  console.error(error);
  return { message: 'error' };
};
