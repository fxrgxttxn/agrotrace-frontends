import { useMemo, useRef } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';

// Session generation of the cache (ruling FM24): the query cache belongs to one signed-in person. Ending a session
// (logout, a lost session, another tab's logout) and starting one clears it and bumps the generation; a write that
// was started in an earlier generation — a late answer of the previous person's request (their channels PUT arriving
// after the next person signed in) — is dropped instead of landing in the new session.

const generations = new WeakMap<QueryClient, number>();

export function cacheGeneration(client: QueryClient): number {
  return generations.get(client) ?? 0;
}

/** Clears the cache for a new session (or none): everything of the previous person goes, their late writes too. */
export function resetSessionCache(client: QueryClient): void {
  generations.set(client, cacheGeneration(client) + 1);
  client.clear();
}

export interface CacheWriter {
  /** `setQueryData`, dropped when the session this component started in has ended. */
  set<T>(key: QueryKey, data: T | ((old: T | undefined) => T | undefined)): void;
}

/** Cache writes of a screen: they carry the generation the screen was shown in (captured at mount). */
export function useCacheWriter(): CacheWriter {
  const client = useQueryClient();
  const born = useRef(cacheGeneration(client));
  return useMemo(
    () => ({
      set: (key, data) => {
        if (cacheGeneration(client) !== born.current) return;
        client.setQueryData(key, data as never);
      },
    }),
    [client],
  );
}
