export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export const withBase = (path: string): string => `${BASE}${path}`;

export function stripBase(path: string): string {
  if (!BASE) return path;
  if (path === BASE) return '/';
  return path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
}
