import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import { canAccess, type Access } from './access';
import { loginUrl, safeNext, SessionService } from './session';

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
      if (s.status === 'authenticated') return replaceWith(router, state.url);
      return true;
    });
};

export function requireRole(access: Access): CanActivateFn {
  return (_route, state) => {
    const router = inject(Router);
    const session = inject(SessionService);
    const me = session.me();
    if (!me) {
      const s = session.state();
      return replaceWith(router, s.status === 'anonymous' && s.loggedOut ? '/login' : loginUrl(state.url));
    }
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

export const twoFactorChallenge: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  const saved = router.getCurrentNavigation()?.extras.state as { challengeId?: unknown } | undefined;
  if (typeof saved?.challengeId === 'string') return true;
  const q = state.url.indexOf('?');
  return replaceWith(router, `/login${q < 0 ? '' : state.url.slice(q)}`);
};
