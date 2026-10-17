const meta = typeof document === 'undefined' ? null : document.querySelector('meta[name="at-base"]');

export const BASE = (meta?.getAttribute('content') ?? '').replace(/\/+$/, '');

export const withBase = (path: string): string =>
  path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path;

export function stripBase(path: string): string {
  if (!BASE) return path;
  if (path === BASE) return '/';
  return path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
}

export function restoreDeepLink(): void {
  if (!BASE) return;
  const rest = new URLSearchParams(location.search).get('__p');
  if (rest === null) return;
  history.replaceState(history.state, '', `${BASE}/${rest.replace(/^\/+/, '')}`);
}
