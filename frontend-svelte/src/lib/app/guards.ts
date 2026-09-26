import { redirect } from '@sveltejs/kit';
import { canAccess } from './access';
import { cabinetRoute } from './routes';
import { loginUrl, safeNext, session } from './session.svelte';

// Route guards (spec §9.2: «guard в +layout.ts»), run by SvelteKit before a page renders. Every guard first waits for
// the start-up restore (`session.start()`, once per app). The same decisions as the React guards (src/app/guards.tsx
// there): anonymous → `/login?next=`, a route of another role → `/403`, a signed-in user on /login → `next` or home.
// A transient failure (`unavailable`, R61/F8) is not a redirect: the cabinet layout shows «Сервис недоступен».

/** Cabinet layout (`(app)/(cabinet)/+layout.ts`): signed-in users only. */
export async function requireAuth(url: URL): Promise<void> {
  // Read before awaiting: SvelteKit re-runs a load that used `url` on every navigation (a guard on each one).
  const here = `${url.pathname}${url.search}`;
  await session.start();
  if (session.status === 'anonymous') redirect(307, session.loggedOut ? '/login' : loginUrl(here));
}

/** Role guard of one §9.4 route (its `+page.ts`): a direct visit to a route of another role goes to `/403`. */
export function requireRole(path: string): () => Promise<void> {
  const route = cabinetRoute(path);
  if (!route || route.path !== path) throw new Error(`not a cabinet route: ${path}`);
  return async () => {
    await session.start();
    if (session.status === 'authenticated' && session.me && !canAccess(session.me, route.access))
      redirect(307, '/403');
  };
}

/** Auth screens (login, 2FA): a signed-in user goes where `next` says (or home). The move itself is made by the page
 * (`GuestOnly.svelte`), not by a `load` redirect: Back to a login entry after signing in is a popstate navigation, and
 * SvelteKit keeps the URL of the entry when a popstate `load` redirects (the address bar said /login while the
 * profile showed). The page replaces the entry instead — as React's <Navigate replace> does. */
export async function guestOnly(): Promise<void> {
  await session.start();
}

/** Where a signed-in visitor of an auth screen goes (`null`: stays). */
export function guestTarget(url: URL): string | null {
  return session.status === 'authenticated' ? safeNext(url.searchParams.get('next')) : null;
}

/** Whether the signed-in user may see the cabinet route at `pathname` (the same rule as `requireRole`). The cabinet
 * layout re-checks it whenever the session changes under a page — e.g. «Повторить» after «Сервис недоступен» restores
 * a session whose roles do not admit the page the user deep-linked to. */
export function mayOpen(pathname: string): boolean {
  if (session.status !== 'authenticated' || !session.me) return false;
  const route = cabinetRoute(pathname);
  return !route || canAccess(session.me, route.access);
}
