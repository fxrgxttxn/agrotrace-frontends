import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast, type ToastInput } from '../ui/Toasts';

const generations = new WeakMap<QueryClient, number>();
const active = new WeakMap<QueryClient, boolean>();

export function cacheGeneration(client: QueryClient): number {
  return generations.get(client) ?? 0;
}

export function sessionActive(client: QueryClient): boolean {
  return active.get(client) ?? false;
}

export function setSessionActive(client: QueryClient, on: boolean): void {
  active.set(client, on);
}

export function resetSessionCache(client: QueryClient): void {
  generations.set(client, cacheGeneration(client) + 1);
  void client.cancelQueries();
  client.clear();
}

export interface CacheWriter {
  set<T>(key: QueryKey, data: T | ((old: T | undefined) => T | undefined)): void;
}

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
  sameSession: () => boolean;
  alive: () => boolean;
  bound: boolean;
}

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

export function useScreenAlive(): () => boolean {
  return useScreenScope().alive;
}

export interface ScreenToast {
  push: (input: ToastInput) => number;
  done: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

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
