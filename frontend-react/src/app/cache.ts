import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast, type ToastInput } from '../ui/Toasts';

// Session generation of the cache (rulings FM24, FM26, FM28, FM29): the query cache belongs to one signed-in person.
// The generation bumps only when an authenticated session actually ends (logout, a lost session, another tab's
// logout while signed in) or a new one starts (sign-in) — never on anonymous → anonymous events. A write started in
// an earlier generation (a late answer of the previous person's request) is dropped instead of landing in the next
// session. Screens shown without a session (login, 2FA, password, invite, register) are never silenced by the
// generation: only by being gone.

const generations = new WeakMap<QueryClient, number>();
const active = new WeakMap<QueryClient, boolean>();

export function cacheGeneration(client: QueryClient): number {
  return generations.get(client) ?? 0;
}

/** Whether a signed-in session is on (set by the session provider as its state changes, synchronously). */
export function sessionActive(client: QueryClient): boolean {
  return active.get(client) ?? false;
}

export function setSessionActive(client: QueryClient, on: boolean): void {
  active.set(client, on);
}

/** A session ends or starts: the cache of the previous person goes, their running requests and retries stop
 * (FM25), their late writes are dropped (a new generation). */
export function resetSessionCache(client: QueryClient): void {
  generations.set(client, cacheGeneration(client) + 1);
  void client.cancelQueries();
  client.clear();
}

export interface CacheWriter {
  /** `setQueryData`, dropped when the session this component started in has ended. */
  set<T>(key: QueryKey, data: T | ((old: T | undefined) => T | undefined)): void;
}

/** Cache writes of a screen: bound to the session generation only (FM26 amendment — a finished mutation of the same
 * person still updates the cache after they left the screen). */
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

export interface ScreenScope {
  /** The session the screen was shown in still lasts (always true for a screen shown without a session). */
  sameSession: () => boolean;
  /** …and the screen is still mounted. */
  alive: () => boolean;
  /** The screen was shown in a signed-in session. */
  bound: boolean;
}

/** The scope of a screen's late UI steps (FM26/FM29): navigation, focus and form alerts need `alive()`; a success toast
 * of a signed-in screen needs only `sameSession()` (it appears in the app-level region even after the screen is gone). */
export function useScreenScope(): ScreenScope {
  const client = useQueryClient();
  const born = useRef(cacheGeneration(client));
  const bound = useRef(sessionActive(client));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sameSession = useCallback(() => !bound.current || cacheGeneration(client) === born.current, [client]);
  const alive = useCallback(() => mounted.current && sameSession(), [sameSession]);
  return useMemo(() => ({ sameSession, alive, bound: bound.current }), [sameSession, alive]);
}

/** Mounted and in its session (FM26): after an `await`, navigation, focus and form alerts run only while true. */
export function useScreenAlive(): () => boolean {
  return useScreenScope().alive;
}

export interface ScreenToast {
  /** A failure, a conflict, any message about the screen: only while the screen is there and its session lasts. */
  push: (input: ToastInput) => number;
  /** A success of the person's action: while its session lasts, even after the screen is gone (the app-level toast
   * region says it; for a screen without a session — password reset, invite — always). Chosen per call site. */
  done: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

/** The screen's toasts (rulings FM29, FM30): failures need the mounted screen; successes need only the session. */
export function useScreenToast(): ScreenToast {
  const toast = useToast();
  const scope = useScreenScope();
  return useMemo(
    () => ({
      push: (input) => (scope.alive() ? toast.push(input) : -1),
      done: (input) => (scope.sameSession() ? toast.push(input) : -1),
      dismiss: toast.dismiss,
    }),
    [toast, scope],
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
