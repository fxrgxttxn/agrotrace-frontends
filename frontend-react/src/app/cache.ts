import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from '../ui/Toasts';

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
  // Requests of the ended session stop, retries included (FM25: no retry after a backoff into the next session).
  void client.cancelQueries();
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

/** The screen is still there and its session still lasts (ruling FM26): after an `await`, the UI steps of an action
 * (toast, navigation, focus) run only while this is true — a late answer after the person left the screen or signed
 * out is silent. */
export function useScreenAlive(): () => boolean {
  const client = useQueryClient();
  const born = useRef(cacheGeneration(client));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current && cacheGeneration(client) === born.current, [client]);
}

/** The screen's toasts: pushed only while the screen is alive (FM26). */
export function useScreenToast(): ReturnType<typeof useToast> {
  const toast = useToast();
  const alive = useScreenAlive();
  return useMemo(
    () => ({ push: (input) => (alive() ? toast.push(input) : -1), dismiss: toast.dismiss }),
    [toast, alive],
  );
}

/** The screen's navigation after an action: only while the screen is alive (FM26 — a late answer never moves the
 * next person, or the person who went elsewhere). */
export function useScreenNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const alive = useScreenAlive();
  return useCallback<NavigateFunction>(
    ((to: To | number, options?: NavigateOptions) => {
      if (!alive()) return;
      if (typeof to === 'number') navigate(to);
      else navigate(to, options);
    }) as NavigateFunction,
    [navigate, alive],
  );
}
