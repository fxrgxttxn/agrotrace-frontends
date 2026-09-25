import { APP_BASE_HREF } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { inject, provideZoneChangeDetection, type ApplicationConfig } from '@angular/core';
import { provideRouter, type Routes } from '@angular/router';
import { buildRoutes } from './app.routes';
import { httpClientFetch } from './http-fetch';
import { createSessionCore, SESSION_CORE } from './session';

/** Providers of the cabinet app (tests build the same set with their own session core and routes). */
export function appConfig(devRoutes: Routes = []): ApplicationConfig {
  return {
    providers: [
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideHttpClient(),
      provideRouter(buildRoutes(devRoutes)),
      // No <base href> in index.html: the skip link `href="#main"` must stay on the current page.
      { provide: APP_BASE_HREF, useValue: '/' },
      { provide: SESSION_CORE, useFactory: () => createSessionCore(httpClientFetch(inject(HttpClient))) },
    ],
  };
}
