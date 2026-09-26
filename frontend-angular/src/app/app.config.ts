import { APP_BASE_HREF } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { inject, provideZoneChangeDetection, type ApplicationConfig } from '@angular/core';
import { provideRouter, withRouterConfig, type Routes } from '@angular/router';
import { buildRoutes } from './app.routes';
import { httpClientFetch } from './http-fetch';
import { createSessionCore, SESSION_CORE } from './session';

/** The URL changes when a navigation starts (FM10: URL and `aria-current` at once, the loading page while the page
 * chunk loads); guard redirects replace the refused entry (guards.ts). Shared with the tests. */
export const ROUTER_CONFIG = withRouterConfig({
  urlUpdateStrategy: 'eager',
  // A cancelled / failed navigation returns to the entry it came from (history.go), never a replaceState over it.
  canceledNavigationResolution: 'computed',
});

/** Providers of the cabinet app (tests build the same set with their own session core and routes). */
export function appConfig(devRoutes: Routes = []): ApplicationConfig {
  return {
    providers: [
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideHttpClient(),
      provideRouter(buildRoutes(devRoutes), ROUTER_CONFIG),
      // No <base href> in index.html: the skip link `href="#main"` must stay on the current page.
      { provide: APP_BASE_HREF, useValue: '/' },
      { provide: SESSION_CORE, useFactory: () => createSessionCore(httpClientFetch(inject(HttpClient))) },
    ],
  };
}
