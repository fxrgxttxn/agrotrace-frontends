import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import { canAccess, type Access } from './access';
import { loginUrl, safeNext, SessionService } from './session';

// Route guards (spec §9.2 `CanActivateFn`, §9.5). Each one first waits for the start-up restore (the root shows the
// loading page meanwhile) — the same decisions as the React guards (behaviour reference):
//   signedIn             the cabinet shell matches only a signed-in user (403 / 404 inside the shell too);
//   toLoginOrUnavailable a cabinet route without a session: anonymous → /login?next= (plain /login after a logout),
//                        a transient failure (R61/F8) → the «Сервис недоступен» screen at that URL;
//   requireRole(access)  a route of another role → /403 (the page chunk is only loaded after this passed);
//   guestOnly            /login, /login/2fa: a signed-in user goes where `next` says (or home).
// Every redirect REPLACES the entry of the refused URL (React's `<Navigate replace>`): with `urlUpdateStrategy:
// 'eager'` that URL is already in the history when the guard runs. `inject` only works before the first `await`.

function replaceWith(router: Router, url: string): RedirectCommand {
  return new RedirectCommand(router.parseUrl(url), { replaceUrl: true });
}

export const signedIn: CanMatchFn = () => {
  const session = inject(SessionService);
  return session.settled().then((s) => s.status === 'authenticated');
};

export const toLoginOrUnavailable: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  return inject(SessionService)
    .settled()
    .then((s) => {
      if (s.status === 'anonymous') return replaceWith(router, s.loggedOut ? '/login' : loginUrl(state.url));
      if (s.status === 'authenticated') return replaceWith(router, state.url); // signed in meanwhile: into the shell
      return true;
    });
};

export function requireRole(access: Access): CanActivateFn {
  return (_route, state) => {
    const router = inject(Router);
    const me = inject(SessionService).me();
    // Never a plain `false` (it would cancel and roll the eager URL back, FM11): no session here means the login.
    if (!me) return replaceWith(router, loginUrl(state.url));
    return canAccess(me, access) || replaceWith(router, '/403');
  };
}

export const guestOnly: CanActivateFn = (route) => {
  const router = inject(Router);
  return inject(SessionService)
    .settled()
    .then((s) =>
      s.status === 'authenticated' ? replaceWith(router, safeNext(route.queryParamMap.get('next'))) : true,
    );
};
