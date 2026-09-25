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

/** Auth screens (login, 2FA): a signed-in user goes where `next` says (or home). */
export async function guestOnly(url: URL): Promise<void> {
  await session.start();
  if (session.status === 'authenticated') redirect(307, safeNext(url.searchParams.get('next')));
}

/** Whether the signed-in user may see the cabinet route at `pathname` (the same rule as `requireRole`). The cabinet
 * layout re-checks it whenever the session changes under a page — e.g. «Повторить» after «Сервис недоступен» restores
 * a session whose roles do not admit the page the user deep-linked to. */
export function mayOpen(pathname: string): boolean {
  if (session.status !== 'authenticated' || !session.me) return false;
  const route = cabinetRoute(pathname);
  return !route || canAccess(session.me, route.access);
}
