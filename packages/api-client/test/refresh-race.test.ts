// R32: refresh single-flight across tabs. These tests model two browser tabs as two separate
// `createApi()` instances with their own TokenStore (tabs never share JS memory), wired to a
// shared Web Locks mock (a real browser shares navigator.locks across same-origin tabs) and a
// shared BroadcastChannel mock (the only way one tab's refresh can reach another's store).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/client';
import { createMemoryTokenStore } from '../src/session';
import { MockBroadcastChannel, MockLockManager, jsonResponse, problemResponse, requestHeaders, requestUrl } from './helpers';

const BASE_URL = 'http://localhost/api/v1';

beforeEach(() => {
  vi.useFakeTimers();
  MockBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('single-flight refresh across two tabs sharing navigator.locks', () => {
  it('only refreshes over the network once, even when both tabs race', async () => {
    const locks = new MockLockManager();
    vi.stubGlobal('navigator', { locks });

    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    let refreshCalls = 0;

    const makeFetch = () =>
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith('/auth/refresh')) {
          refreshCalls += 1;
          return jsonResponse({ accessToken: 'fresh', expiresIn: 900 });
        }
        return requestHeaders(input, init).get('Authorization') === 'Bearer fresh'
          ? jsonResponse({ ok: true })
          : problemResponse({ code: 'UNAUTHORIZED' }, 401);
      });

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: makeFetch() });
    const apiB = createApi({ baseUrl: BASE_URL, session: sessionB, fetch: makeFetch() });

    const [resultA, resultB] = await Promise.all([apiA.GET('/me'), apiB.GET('/me')]);

    expect(refreshCalls).toBe(1);
    expect(resultA.response.status).toBe(200);
    expect(resultB.response.status).toBe(200);
    // Even though tab B never talked to /auth/refresh itself, the broadcast from tab A's refresh
    // updated tab B's own store.
    expect(sessionB.get()).toBe('fresh');
  });

  it("keeps an idle tab's store in sync via the broadcast alone — no request or lock on that side", async () => {
    // No navigator.locks stub here: tab B never asks to refresh at all, so there is nothing to
    // serialize on its side — only its permanent BroadcastChannel listener is in play.
    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh') ? jsonResponse({ accessToken: 'fresh', expiresIn: 900 }) : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn();

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB });

    await apiA.refresh();

    expect(sessionB.get()).toBe('fresh');
    expect(fetchB).not.toHaveBeenCalled();
  });
});

describe('grace window (R32): 401 from our own refresh may mean another tab already won', () => {
  it('waits for the broadcast token instead of logging out when another tab wins the race', async () => {
    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    const onAuthLostB = vi.fn();

    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh') ? jsonResponse({ accessToken: 'won', expiresIn: 900 }) : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        // Server's view: tab A's rotation already replaced this token (R32/R40 reuse-in-grace-window).
        return problemResponse({ code: 'TOKEN_EXPIRED' }, 401);
      }
      return requestHeaders(input, init).get('Authorization') === 'Bearer won'
        ? jsonResponse({ ok: true })
        : problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    const apiB = createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB, onAuthLost: onAuthLostB });

    // Tab B's request hits 401, asks to refresh, and its own refresh call comes back 401 — it now
    // sits in the grace-window wait for a broadcast.
    const bPromise = apiB.GET('/me');
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthLostB).not.toHaveBeenCalled();

    // Only *now* does tab A's refresh (racing at the "server") complete and broadcast.
    await apiA.refresh();

    const result = await bPromise;

    expect(result.response.status).toBe(200);
    expect(sessionB.get()).toBe('won');
    expect(onAuthLostB).not.toHaveBeenCalled();
  });

  it('logs out if nothing arrives before the grace window elapses', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? problemResponse({ code: 'TOKEN_EXPIRED' }, 401)
        : problemResponse({ code: 'UNAUTHORIZED' }, 401),
    );
    const api = createApi({ baseUrl: BASE_URL, session, fetch, onAuthLost });

    const promise = api.GET('/me');
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.response.status).toBe(401);
    expect(session.get()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });
});
