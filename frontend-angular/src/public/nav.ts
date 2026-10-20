import { signal } from '@angular/core';

// The two public routes are matched by hand (no router in the light build); links between them navigate on the client
// (history.pushState), Back/Forward through popstate.

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

export const batchPath = (code: string) => `/p/${encodeURIComponent(code)}`;
export const complaintPath = (code: string) => `${batchPath(code)}/complaint`;

/** The path shown (follows navigate and Back/Forward — the app listens to popstate). */
export const path = signal(typeof location === 'undefined' ? '/' : location.pathname);

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  path.set(window.location.pathname);
}

/** A plain left click on a link of the public page navigates on the client; other clicks keep the browser's way. */
export function onLink(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!);
}
