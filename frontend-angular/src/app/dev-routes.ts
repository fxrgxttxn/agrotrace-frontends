import type { Routes } from '@angular/router';

/** Development-only routes (`/_ds`, spec §10.7). The production build has none; `ng build -c development` / `ng serve`
 * replace this file with dev-routes.dev.ts (angular.json `fileReplacements`), so the showcase chunk never ships. */
export const DEV_ROUTES: Routes = [];
