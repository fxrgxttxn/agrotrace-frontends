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
import { guestOnly, requireRole, signedIn, toLoginOrUnavailable, twoFactorChallenge } from './guards';
import { AUTH_ROUTES, CABINET_ROUTES } from './routes';
import { SHELL_PAGE_LOADERS } from './navigation';
import { ShellComponent } from './shell/shell';

const GUEST_ONLY = new Set(['/login', '/login/2fa']);

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
      canActivate: [
        ...(GUEST_ONLY.has(r.path) ? [guestOnly] : []),
        ...(r.path === '/login/2fa' ? [twoFactorChallenge] : []),
      ],
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
      runGuardsAndResolvers: 'always' as const,
      component: UnavailablePage,
    })),
    { path: '403', component: ForbiddenStandalonePage },
    { path: '**', component: NotFoundStandalonePage },
  ];
}
