import { redirect } from '@sveltejs/kit';
import { canAccess } from './access';
import { stripBase, withBase } from './paths';
import { cabinetRoute } from './routes';
import { loginUrl, safeNext, session } from './session.svelte';

export async function requireAuth(url: URL): Promise<void> {
  const here = `${stripBase(url.pathname)}${url.search}`;
  await session.start();
  if (session.status === 'anonymous') redirect(307, withBase(session.loggedOut ? '/login' : loginUrl(here)));
}

export function requireRole(path: string): () => Promise<void> {
  const route = cabinetRoute(path);
  if (!route || route.path !== path) throw new Error(`not a cabinet route: ${path}`);
  return async () => {
    await session.start();
    if (session.status === 'authenticated' && session.me && !canAccess(session.me, route.access))
      redirect(307, withBase('/403'));
  };
}

export async function guestOnly(): Promise<void> {
  await session.start();
}

export function guestTarget(url: URL): string | null {
  return session.status === 'authenticated' ? safeNext(url.searchParams.get('next')) : null;
}

export function mayOpen(pathname: string): boolean {
  if (session.status !== 'authenticated' || !session.me) return false;
  const route = cabinetRoute(pathname);
  return !route || canAccess(session.me, route.access);
}
