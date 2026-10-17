import { useSyncExternalStore, type MouseEvent } from 'react';
import { stripBase, withBase } from '../base';

export type PublicRoute =
  { name: 'batch'; code: string } | { name: 'complaint'; code: string } | { name: 'none' };

export function matchPublic(path: string): PublicRoute {
  const m = /^\/p\/([^/]+)(\/complaint)?\/?$/.exec(path);
  if (!m) return { name: 'none' };
  let code: string;
  try {
    code = decodeURIComponent(m[1]!);
  } catch {
    return { name: 'none' };
  }
  return m[2] ? { name: 'complaint', code } : { name: 'batch', code };
}

export const batchPath = (code: string) => withBase(`/p/${encodeURIComponent(code)}`);
export const complaintPath = (code: string) => `${batchPath(code)}/complaint`;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => stripBase(window.location.pathname));
}

export function onLink(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute('href')!);
}
