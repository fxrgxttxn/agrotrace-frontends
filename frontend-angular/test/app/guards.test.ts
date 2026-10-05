import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  RedirectCommand,
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { requireRole } from '../../src/app/guards';
import { SessionService, type SessionState } from '../../src/app/session';

function run(state: SessionState, url = '/admin/users') {
  const s = signal<SessionState>(state);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: SessionService,
        useValue: {
          state: s,
          me: () => (s().status === 'authenticated' ? (s() as { me: unknown }).me : null),
        },
      },
    ],
  });
  const guard = requireRole({ roles: ['ADMIN'] });
  return TestBed.runInInjectionContext(() =>
    guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  ) as RedirectCommand | boolean;
}

const target = (r: RedirectCommand | boolean) =>
  r instanceof RedirectCommand ? TestBed.inject(Router).serializeUrl(r.redirectTo) : r;

describe('requireRole without a session', () => {
  it('session lost: /login?next=, replacing the entry', () => {
    const r = run({ status: 'anonymous' });
    expect(r).toBeInstanceOf(RedirectCommand);
    expect(target(r)).toBe('/login?next=%2Fadmin%2Fusers');
    expect((r as RedirectCommand).navigationBehaviorOptions?.replaceUrl).toBe(true);
  });

  it('after an explicit logout: plain /login', () => {
    expect(target(run({ status: 'anonymous', loggedOut: true }))).toBe('/login');
  });

  it('another role: /403', () => {
    const me = { roles: ['FARMER'], isOrgAdmin: false };
    expect(target(run({ status: 'authenticated', me } as never))).toBe('/403');
  });
});
