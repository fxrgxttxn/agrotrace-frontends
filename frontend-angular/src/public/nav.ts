import { signal } from '@angular/core';
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

export const currentPath = (): string => stripBase(location.pathname);

export const path = signal(typeof location === 'undefined' ? '/' : currentPath());

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  path.set(currentPath());
}

export function onLink(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!);
}
