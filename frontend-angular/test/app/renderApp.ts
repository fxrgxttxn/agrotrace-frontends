import { APP_BASE_HREF } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach } from 'vitest';
import { AppComponent } from '../../src/app/app.component';
import { buildRoutes } from '../../src/app/app.routes';
import { ROUTER_CONFIG } from '../../src/app/app.config';
import { DEV_ROUTES } from '../../src/app/dev-routes.dev';
import { httpClientFetch } from '../../src/app/http-fetch';
import { EVENT_SOURCE } from '../../src/app/live-events';
import { createSessionCore, SESSION_CORE, type SessionCore } from '../../src/app/session';

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1);
  }
  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown, lastEventId = ''): void {
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

let current: SessionCore | null = null;
afterEach(() => {
  current?.api.dispose();
  current = null;
  FakeEventSource.instances = [];
});

export interface AppHarness {
  fixture: ComponentFixture<AppComponent>;
  router: Router;
  core: SessionCore;
  url: () => string;
}

export function renderApp(path: string): AppHarness {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(buildRoutes(DEV_ROUTES), ROUTER_CONFIG),
      provideLocationMocks(),
      { provide: APP_BASE_HREF, useValue: '/' },
      {
        provide: SESSION_CORE,
        useFactory: () => {
          current = createSessionCore(httpClientFetch(inject(HttpClient)));
          return current;
        },
      },
      { provide: EVENT_SOURCE, useValue: FakeEventSource as unknown as typeof EventSource },
    ],
  });
  const fixture = TestBed.createComponent(AppComponent);
  fixture.autoDetectChanges(true);
  const router = TestBed.inject(Router);
  router.setUpLocationChangeListener();
  void fixture.ngZone!.run(() => router.navigateByUrl(path));
  return { fixture, router, core: TestBed.inject(SESSION_CORE), url: () => router.url };
}
