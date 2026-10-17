import { base } from '$app/paths';

export function withBase(path: string): string {
  if (!base || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) return path;
  return `${base}${path}`;
}

export function stripBase(pathname: string): string {
  if (!base) return pathname;
  if (pathname === base) return '/';
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}
