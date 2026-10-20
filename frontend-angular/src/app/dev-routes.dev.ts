import type { Routes } from '@angular/router';

/** `/_ds` — the component showcase (spec §10.7), development build only (see dev-routes.ts). */
export const DEV_ROUTES: Routes = [
  { path: '_ds', loadComponent: () => import('../dev/showcase').then((m) => m.ShowcasePage) },
];
