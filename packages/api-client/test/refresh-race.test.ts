import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/client';
import { createMemoryTokenStore } from '../src/session';
import {
  MockBroadcastChannel,
  MockLockManager,
  afterMs,
  jsonResponse,
  problemResponse,
  requestHeaders,
  requestUrl,
} from './helpers';

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
  it('both tabs converge on the same fresh token and neither logs out, even if both end up calling refresh', async () => {
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

    const onAuthLostA = vi.fn();
    const onAuthLostB = vi.fn();
    const apiA = createApi({
      baseUrl: BASE_URL,
      session: sessionA,
      fetch: makeFetch(),
      onAuthLost: onAuthLostA,
    });
    const apiB = createApi({
      baseUrl: BASE_URL,
      session: sessionB,
      fetch: makeFetch(),
      onAuthLost: onAuthLostB,
    });

    const [resultA, resultB] = await Promise.all([apiA.GET('/me'), apiB.GET('/me')]);

    expect(refreshCalls).toBeLessThanOrEqual(2);
    expect(resultA.response.status).toBe(200);
    expect(resultB.response.status).toBe(200);
    expect(sessionA.get()).toBe('fresh');
    expect(sessionB.get()).toBe('fresh');
    expect(onAuthLostA).not.toHaveBeenCalled();
    expect(onAuthLostB).not.toHaveBeenCalled();
  });

  it("keeps an idle tab's store in sync via the broadcast alone — no request or lock on that side", async () => {
    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? jsonResponse({ accessToken: 'fresh', expiresIn: 900 })
        : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn();

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB });

    await apiA.refresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionB.get()).toBe('fresh');
    expect(fetchB).not.toHaveBeenCalled();
  });

  it('Important 1/gap: a request whose own token was already superseded when its 401 arrives never triggers a duplicate network refresh', async () => {
    const locks = new MockLockManager();
    vi.stubGlobal('navigator', { locks });

    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    let refreshCalls = 0;

    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? (refreshCalls++, jsonResponse({ accessToken: 'fresh', expiresIn: 900 }))
        : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (requestHeaders(input, init).get('Authorization') === 'Bearer fresh')
        return jsonResponse({ ok: true });
      return afterMs(300, problemResponse({ code: 'UNAUTHORIZED' }, 401));
    });

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    const apiB = createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB });

    const bPromise = apiB.GET('/me');

    await vi.advanceTimersByTimeAsync(50);
    await apiA.refresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionB.get()).toBe('fresh');

    await vi.advanceTimersByTimeAsync(250);
    await bPromise;

    expect(refreshCalls).toBe(1);
    expect(fetchB.mock.calls.filter(([input]) => requestUrl(input).endsWith('/auth/refresh'))).toHaveLength(
      0,
    );
  });
});

describe('Important 2: a broadcast landing before our own refresh call resolves 401 must not be clobbered', () => {
  it('keeps the token a broadcast already installed even when our own slow /auth/refresh later comes back 401', async () => {
    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    const onAuthLostB = vi.fn();

    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? jsonResponse({ accessToken: 'fromA', expiresIn: 900 })
        : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        return afterMs(200, problemResponse({ code: 'TOKEN_EXPIRED' }, 401));
      }
      return requestHeaders(input, init).get('Authorization') === 'Bearer fromA'
        ? jsonResponse({ ok: true })
        : problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    const apiB = createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB, onAuthLost: onAuthLostB });

    const bPromise = apiB.GET('/me');
    await vi.advanceTimersByTimeAsync(10);

    await apiA.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionB.get()).toBe('fromA');

    await vi.advanceTimersByTimeAsync(190);
    const result = await bPromise;

    expect(sessionB.get()).toBe('fromA');
    expect(onAuthLostB).not.toHaveBeenCalled();
    expect(result.response.status).toBe(200);
  });
});

describe('grace window (R32): 401 from our own refresh may mean another tab already won', () => {
  it('waits for the broadcast token instead of logging out when another tab wins the race', async () => {
    const sessionA = createMemoryTokenStore('stale');
    const sessionB = createMemoryTokenStore('stale');
    const onAuthLostB = vi.fn();

    const fetchA = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? jsonResponse({ accessToken: 'won', expiresIn: 900 })
        : jsonResponse({ ok: true }),
    );
    const fetchB = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        return problemResponse({ code: 'TOKEN_EXPIRED' }, 401);
      }
      return requestHeaders(input, init).get('Authorization') === 'Bearer won'
        ? jsonResponse({ ok: true })
        : problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });

    const apiA = createApi({ baseUrl: BASE_URL, session: sessionA, fetch: fetchA });
    const apiB = createApi({ baseUrl: BASE_URL, session: sessionB, fetch: fetchB, onAuthLost: onAuthLostB });

    const bPromise = apiB.GET('/me');
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthLostB).not.toHaveBeenCalled();

    await apiA.refresh();
    await vi.advanceTimersByTimeAsync(0);

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

describe('Important 3: the grace wait is skipped when it cannot possibly help', () => {
  it('skips it when Web Locks were used — no same-browser tab could be racing us while we hold the lock', async () => {
    const locks = new MockLockManager();
    vi.stubGlobal('navigator', { locks });

    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request) =>
      requestUrl(input).endsWith('/auth/refresh')
        ? problemResponse({ code: 'TOKEN_EXPIRED' }, 401)
        : problemResponse({ code: 'UNAUTHORIZED' }, 401),
    );
    const api = createApi({ baseUrl: BASE_URL, session, fetch, onAuthLost });

    const promise = api.GET('/me');
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.response.status).toBe(401);
    expect(session.get()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('skips it when there was no token at all — nothing to race over (boot without a session)', async () => {
    const session = createMemoryTokenStore(null);
    const onAuthLost = vi.fn();
    const fetch = vi.fn(async () => problemResponse({ code: 'TOKEN_EXPIRED' }, 401));
    const api = createApi({ baseUrl: BASE_URL, session, fetch, onAuthLost });

    const promise = api.refresh();
    await vi.advanceTimersByTimeAsync(50);
    const newToken = await promise;

    expect(newToken).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });
});

describe('Minor D: a transient refresh failure is shared among callers queued behind the same Web Lock', () => {
  it('does not make one /auth/refresh call per queued caller during an outage', async () => {
    const locks = new MockLockManager();
    vi.stubGlobal('navigator', { locks });

    const session = createMemoryTokenStore('stale');
    let refreshCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return new Response('', { status: 503 });
      }
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch });

    const results = await Promise.allSettled([api.GET('/me'), api.GET('/me'), api.GET('/me')]);

    for (const result of results) expect(result.status).toBe('rejected');
    expect(refreshCalls).toBe(1);
    expect(session.get()).toBe('stale');
  });
});

describe('a refresh answered after the session ended or changed (generation check)', () => {
  it('a token arriving after a logout (the store was cleared meanwhile) is neither installed nor broadcast', async () => {
    const session = createMemoryTokenStore(null);
    const peer = new MockBroadcastChannel('agrotrace-auth');
    const heard: unknown[] = [];
    peer.addEventListener('message', (e) => heard.push(e.data));
    const fetch = vi.fn(() => afterMs(100, jsonResponse({ accessToken: 'late-token' })));
    const api = createApi({ baseUrl: BASE_URL, session, fetch });

    const pending = api.refresh();
    await vi.advanceTimersByTimeAsync(10);
    session.set(null);
    await vi.advanceTimersByTimeAsync(200);

    expect(await pending).toBeNull();
    expect(session.get()).toBeNull();
    expect(heard).toEqual([]);
  });

  it('a token arriving after a sign-in installed another one keeps the sign-in token', async () => {
    const session = createMemoryTokenStore(null);
    const peer = new MockBroadcastChannel('agrotrace-auth');
    const heard: unknown[] = [];
    peer.addEventListener('message', (e) => heard.push(e.data));
    const fetch = vi.fn(() => afterMs(100, jsonResponse({ accessToken: 'old-cookie-token' })));
    const api = createApi({ baseUrl: BASE_URL, session, fetch });

    const pending = api.refresh();
    await vi.advanceTimersByTimeAsync(10);
    session.set('signed-in-token');
    await vi.advanceTimersByTimeAsync(200);

    expect(await pending).toBe('signed-in-token');
    expect(session.get()).toBe('signed-in-token');
    expect(heard).toEqual([]);
  });
});
