import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';
import {
  ForbiddenPage,
  ForbiddenStandalonePage,
  NotFoundPage,
  NotFoundStandalonePage,
  PageLoadFailedPage,
  PageLoadFailedStandalonePage,
  UnavailablePage,
} from '../pages/errors';
import { resilientLoad } from './chunk';
import { guestOnly, requireRole, signedIn, toLoginOrUnavailable } from './guards';
import { AUTH_ROUTES, CABINET_ROUTES } from './routes';
import { SHELL_PAGE_LOADERS } from './navigation';
import { ShellComponent } from './shell/shell';

/** Guest-only auth screens: a signed-in user is sent on (`next` or home). */
const GUEST_ONLY = new Set(['/login', '/login/2fa']);

/** `/p/*` belongs to the separate public entry: a client-side navigation into it reloads the document so the cabinet
 * code never serves it. */
@Component({
  selector: 'at-public-reload',
  standalone: true,
  template: ``,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicReloadComponent {
  constructor() {
    window.location.replace(inject(Router).url);
  }
}

/** All routes of spec §9.4 (the public QR pages are the separate entry src/public). Order matters:
 *  1. auth screens (no session needed; /login and /login/2fa are guest-only);
 *  2. the cabinet shell — matched only for a signed-in user — with every cabinet route (role guard, lazy page) and its
 *     own 403 / 404 inside the shell;
 *  3. the same cabinet paths without a session: to /login?next= or, on a transient failure, «Сервис недоступен»;
 *  4. standalone 403 / 404. */
export function buildRoutes(devRoutes: Routes = []): Routes {
  const shellChildren: Routes = [
    ...CABINET_ROUTES.map((r) => ({
      path: r.path.slice(1),
      pathMatch: 'full' as const,
      canActivate: [requireRole(r.access)],
      data: { title: r.title },
      loadComponent: resilientLoad(r.load, PageLoadFailedPage),
    })),
    { path: '403', component: ForbiddenPage },
    { path: '**', component: NotFoundPage },
  ];
  for (const r of shellChildren) if (r.loadComponent) SHELL_PAGE_LOADERS.add(r.loadComponent);
  return [
    ...AUTH_ROUTES.map((r) => ({
      path: r.path.slice(1),
      data: { title: r.title },
      loadComponent: resilientLoad(r.load, PageLoadFailedStandalonePage),
      canActivate: GUEST_ONLY.has(r.path) ? [guestOnly] : [],
    })),
    { path: 'p', children: [{ path: '**', component: PublicReloadComponent }] },
    ...devRoutes,
    {
      path: '',
      component: ShellComponent,
      canMatch: [signedIn],
      children: shellChildren,
    },
    ...CABINET_ROUTES.map((r) => ({
      path: r.path.slice(1),
      pathMatch: 'full' as const,
      canActivate: [toLoginOrUnavailable],
      // «Повторить» reloads this same URL: the guard must decide again (anonymous now → /login?next=).
      runGuardsAndResolvers: 'always' as const,
      component: UnavailablePage,
    })),
    { path: '403', component: ForbiddenStandalonePage },
    { path: '**', component: NotFoundStandalonePage },
  ];
}
