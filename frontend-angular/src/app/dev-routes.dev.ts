import type { Routes } from '@angular/router';

export const DEV_ROUTES: Routes = [
  { path: '_ds', loadComponent: () => import('../dev/showcase').then((m) => m.ShowcasePage) },
];
