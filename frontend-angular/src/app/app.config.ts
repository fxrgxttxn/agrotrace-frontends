import { APP_BASE_HREF } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { inject, provideZoneChangeDetection, type ApplicationConfig } from '@angular/core';
import { provideRouter, withRouterConfig, type Routes } from '@angular/router';
import { BASE } from '../base';
import { buildRoutes } from './app.routes';
import { httpClientFetch } from './http-fetch';
import { createSessionCore, SESSION_CORE } from './session';

export const ROUTER_CONFIG = withRouterConfig({
  urlUpdateStrategy: 'eager',
  canceledNavigationResolution: 'computed',
});

export function appConfig(devRoutes: Routes = []): ApplicationConfig {
  return {
    providers: [
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideHttpClient(),
      provideRouter(buildRoutes(devRoutes), ROUTER_CONFIG),
      { provide: APP_BASE_HREF, useValue: `${BASE}/` },
      { provide: SESSION_CORE, useFactory: () => createSessionCore(httpClientFetch(inject(HttpClient))) },
    ],
  };
}
