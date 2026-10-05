import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createApi, newIdempotencyKey, withVariant } from '../src/client';
import { createMemoryTokenStore } from '../src/session';
import {
  MockBroadcastChannel,
  afterMs,
  jsonResponse,
  noContentResponse,
  problemResponse,
  requestCredentials,
  requestHeaders,
  requestUrl,
} from './helpers';

const BASE_URL = 'http://localhost/api/v1';

const ME_BODY = {
  id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  email: 'petrov@kfh-petrov.ru',
  fullName: 'Петров Иван Сергеевич',
  roles: ['FARMER'],
};

beforeEach(() => {
  vi.useFakeTimers();
  MockBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createApi — Bearer injection and request headers', () => {
  it('attaches Authorization: Bearer <token> from the session store', async () => {
    const session = createMemoryTokenStore('abc123');
    const fetchMock = vi.fn(async () => jsonResponse(ME_BODY));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    await api.GET('/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(requestHeaders(input, init).get('Authorization')).toBe('Bearer abc123');
  });

  it('sends no Authorization header when the store holds no token', async () => {
    const session = createMemoryTokenStore(null);
    const fetchMock = vi.fn(async () => jsonResponse(ME_BODY));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    await api.GET('/me');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(requestHeaders(input, init).get('Authorization')).toBeNull();
  });

  it('sets a unique X-Request-Id on every request', async () => {
    const session = createMemoryTokenStore('abc123');
    const fetchMock = vi.fn(async () => jsonResponse(ME_BODY));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    await api.GET('/me');
    await api.GET('/me');

    const ids = fetchMock.mock.calls.map(([input, init]) => requestHeaders(input, init).get('X-Request-Id'));
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sends credentials: include for /auth/refresh and /auth/logout only — not /me, and not other security: [] /auth/* calls like /auth/login', async () => {
    const session = createMemoryTokenStore('abc123');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/logout')) return noContentResponse();
      if (requestUrl(input).endsWith('/auth/login'))
        return jsonResponse({ twoFactorRequired: false, accessToken: 'x', expiresIn: 900, user: {} });
      return jsonResponse(ME_BODY);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    await api.GET('/me');
    await api.POST('/auth/logout');
    await api.POST('/auth/login', { body: { email: 'petrov@kfh-petrov.ru', password: 'Correct-Passw0rd!' } });

    const [meInput, meInit] = fetchMock.mock.calls[0]!;
    const [logoutInput, logoutInit] = fetchMock.mock.calls[1]!;
    const [loginInput, loginInit] = fetchMock.mock.calls[2]!;
    expect(requestCredentials(meInput, meInit)).not.toBe('include');
    expect(requestCredentials(logoutInput, logoutInit)).toBe('include');
    expect(requestCredentials(loginInput, loginInit)).not.toBe('include');
  });
});

describe('createApi — 401 handling with single-flight refresh', () => {
  it('refreshes exactly once for three parallel 401s and retries all three', async () => {
    const session = createMemoryTokenStore('stale');
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        expect(requestCredentials(input, init)).toBe('include');
        return jsonResponse({ accessToken: 'fresh', expiresIn: 900 });
      }
      const token = requestHeaders(input, init).get('Authorization');
      if (token === 'Bearer fresh') return jsonResponse(ME_BODY);
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });

    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const results = await Promise.all([api.GET('/me'), api.GET('/me'), api.GET('/me')]);

    expect(refreshCalls).toBe(1);
    for (const result of results) {
      expect(result.response.status).toBe(200);
      expect(result.data).toEqual(ME_BODY);
    }
    expect(session.get()).toBe('fresh');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('calls onAuthLost and clears the store when refresh itself fails', async () => {
    const session = createMemoryTokenStore('stale');

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) {
        return problemResponse({ code: 'FORBIDDEN', params: { reason: 'USER_BLOCKED' } }, 403);
      }
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });

    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.GET('/me');

    expect(result.response.status).toBe(401);
    expect(session.get()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    const refreshCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it('never tries to refresh-and-retry a 401 from /auth/refresh or /auth/logout themselves', async () => {
    const session = createMemoryTokenStore('stale');
    const fetchMock = vi.fn(async () => problemResponse({ code: 'TOKEN_EXPIRED' }, 401));
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await api.POST('/auth/logout');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});

describe('createApi — idempotency-key retry (R48/R53)', () => {
  it('waits Retry-After seconds and retries the same request on 409 IDEMPOTENCY_KEY_IN_PROGRESS', async () => {
    const session = createMemoryTokenStore('abc');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        return problemResponse({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' }, 409, { 'Retry-After': '1' });
      return jsonResponse(ME_BODY);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const promise = api.GET('/me');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(calls).toBe(2);
    expect(result.response.status).toBe(200);
  });

  it('defaults the wait to 1s when Retry-After is absent, and stops after 5 retries', async () => {
    const session = createMemoryTokenStore('abc');
    const fetchMock = vi.fn(async () => problemResponse({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' }, 409));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const promise = api.GET('/me');
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.response.status).toBe(409);
  });

  it('does not retry a 409 with a different code (e.g. IDEMPOTENCY_KEY_REUSED)', async () => {
    const session = createMemoryTokenStore('abc');
    const fetchMock = vi.fn(async () => problemResponse({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const result = await api.GET('/me');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(409);
  });
});

describe('newIdempotencyKey', () => {
  it('returns unique RFC 4122 UUIDs', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

describe('withVariant', () => {
  it('adds ?variant= to a public URL with no existing query', () => {
    expect(withVariant('/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a', 96)).toBe(
      '/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a?variant=96',
    );
  });

  it('sets variant without touching exp/sig on a signed URL', () => {
    const signed = '/api/v1/files/3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f?exp=1790247600&sig=9f2c4e6a';
    const result = withVariant(signed, 480);
    const [, query] = result.split('?');
    const params = new URLSearchParams(query);
    expect(params.get('exp')).toBe('1790247600');
    expect(params.get('sig')).toBe('9f2c4e6a');
    expect(params.get('variant')).toBe('480');
  });

  it('replaces an existing variant instead of duplicating it', () => {
    const url = '/api/v1/files/id?exp=1&sig=abc&variant=96';
    const result = withVariant(url, 480);
    const params = new URLSearchParams(result.split('?')[1]);
    expect(params.getAll('variant')).toEqual(['480']);
  });
});

describe('Critical: /auth/* 401s never trigger refresh-and-retry (or onAuthLost)', () => {
  it('a 401 from /auth/login (wrong password) is returned as-is', async () => {
    const session = createMemoryTokenStore(null);
    const fetchMock = vi.fn(async () => problemResponse({ code: 'INVALID_CREDENTIALS' }, 401));
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.POST('/auth/login', {
      body: { email: 'petrov@kfh-petrov.ru', password: 'Wr0ngPassword!' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(result.response.status).toBe(401);
  });

  it('a 401 ACCOUNT_LOCKED from a re-sent /auth/login is also returned as-is, not retried', async () => {
    const session = createMemoryTokenStore(null);
    const fetchMock = vi.fn(async () =>
      problemResponse({ code: 'ACCOUNT_LOCKED', params: { lockedUntil: '2026-09-24T08:45:00Z' } }, 401),
    );
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.POST('/auth/login', {
      body: { email: 'petrov@kfh-petrov.ru', password: 'Wr0ngPassword!' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(result.response.status).toBe(401);
  });

  it('a 401 from /auth/2fa/verify (wrong or re-sent code) is returned as-is', async () => {
    const session = createMemoryTokenStore(null);
    const fetchMock = vi.fn(async () =>
      problemResponse({ code: 'INVALID_TWO_FACTOR_CODE', params: { attemptsLeft: 3 } }, 401),
    );
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.POST('/auth/2fa/verify', {
      body: { challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f', code: '000000' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(result.response.status).toBe(401);
  });

  it('holds even when a Bearer token happens to be attached to a security: [] call', async () => {
    const session = createMemoryTokenStore('abc123');
    const fetchMock = vi.fn(async () => problemResponse({ code: 'INVALID_CREDENTIALS' }, 401));
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.POST('/auth/login', {
      body: { email: 'petrov@kfh-petrov.ru', password: 'Wr0ngPassword!' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(result.response.status).toBe(401);
  });
});

describe('R62: bearer-secured /auth/* operations (e.g. /auth/2fa/setup) refresh on 401 like any other call', () => {
  it('refreshes and retries a 401 TOKEN_EXPIRED from /auth/2fa/setup', async () => {
    const session = createMemoryTokenStore('stale');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) return jsonResponse({ accessToken: 'fresh', expiresIn: 900 });
      const token = requestHeaders(input, init).get('Authorization');
      if (token === 'Bearer fresh')
        return jsonResponse({ totpEnabled: false, secret: 'x', otpauthUrl: 'otpauth://x' });
      return problemResponse({ code: 'TOKEN_EXPIRED' }, 401);
    });
    const onAuthLost = vi.fn();
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.POST('/auth/2fa/setup', { body: {} });

    expect(result.response.status).toBe(200);
    expect(session.get()).toBe('fresh');
    expect(onAuthLost).not.toHaveBeenCalled();
    const refreshCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('brief gap: a second 401 after a successful refresh means that token is no good either', () => {
  it('calls onAuthLost and clears the store when the retry with the freshly-refreshed token still gets 401', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) return jsonResponse({ accessToken: 'also-bad', expiresIn: 900 });
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const result = await api.GET('/me');

    expect(result.response.status).toBe(401);
    expect(session.get()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    const refreshCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    const meCalls = fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/me'));
    expect(meCalls).toHaveLength(2);
  });
});

describe('Important: a 401 for a token already superseded in the store never triggers a redundant refresh', () => {
  it('a slow request that used the old token retries with whatever a concurrent request already refreshed to', async () => {
    const session = createMemoryTokenStore('T1');
    let refreshCalls = 0;
    let meCallsWithOldToken = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return jsonResponse({ accessToken: 'T2', expiresIn: 900 });
      }
      const token = requestHeaders(input, init).get('Authorization');
      if (token === 'Bearer T2') return jsonResponse(ME_BODY);
      meCallsWithOldToken += 1;
      if (meCallsWithOldToken === 1) return afterMs(200, problemResponse({ code: 'UNAUTHORIZED' }, 401));
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const slow = api.GET('/me');
    await vi.advanceTimersByTimeAsync(1);
    const fast = api.GET('/me');
    await fast;

    expect(session.get()).toBe('T2');
    expect(refreshCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(199);
    const slowResult = await slow;

    expect(refreshCalls).toBe(1);
    expect(slowResult.response.status).toBe(200);
  });
});

describe('Important: request body and Idempotency-Key survive a retry', () => {
  const WAYBILL_BODY = {
    receiverOrgId: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
    items: [{ batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c', massDeclaredKg: '12480.000' }],
  };

  async function bodyOf(input: string | URL | Request): Promise<string> {
    return input instanceof Request ? input.clone().text() : '';
  }

  it('preserves the same Idempotency-Key and body through a 401 refresh-retry', async () => {
    const session = createMemoryTokenStore('stale');
    const key = newIdempotencyKey();
    const seenKeys: Array<string | null> = [];
    const seenBodies: string[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) return jsonResponse({ accessToken: 'fresh', expiresIn: 900 });
      seenKeys.push(requestHeaders(input, init).get('Idempotency-Key'));
      seenBodies.push(await bodyOf(input));
      const token = requestHeaders(input, init).get('Authorization');
      if (token === 'Bearer fresh') return jsonResponse({ id: 'w1' }, { status: 201 });
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const result = await api.POST('/waybills', { headers: { 'Idempotency-Key': key }, body: WAYBILL_BODY });

    expect(result.response.status).toBe(201);
    expect(seenKeys).toEqual([key, key]);
    expect(seenBodies[1]).toBe(seenBodies[0]);
    expect(JSON.parse(seenBodies[0]!)).toEqual(WAYBILL_BODY);
  });

  it('preserves the same Idempotency-Key and body through a 409 IN_PROGRESS retry', async () => {
    const session = createMemoryTokenStore('abc');
    const key = newIdempotencyKey();
    const seenKeys: Array<string | null> = [];
    const seenBodies: string[] = [];
    let attempt = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenKeys.push(requestHeaders(input, init).get('Idempotency-Key'));
      seenBodies.push(await bodyOf(input));
      attempt += 1;
      if (attempt === 1)
        return problemResponse({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' }, 409, { 'Retry-After': '1' });
      return jsonResponse({ id: 'w1' }, { status: 201 });
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const promise = api.POST('/waybills', { headers: { 'Idempotency-Key': key }, body: WAYBILL_BODY });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.response.status).toBe(201);
    expect(seenKeys).toEqual([key, key]);
    expect(seenBodies[1]).toBe(seenBodies[0]);
    expect(JSON.parse(seenBodies[0]!)).toEqual(WAYBILL_BODY);
  });
});

describe('Important: Retry-After is honored precisely, not just "eventually"', () => {
  it('does not resend at 2s but does resend at 3s for Retry-After: 3', async () => {
    const session = createMemoryTokenStore('abc');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        return problemResponse({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' }, 409, { 'Retry-After': '3' });
      return jsonResponse(ME_BODY);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    const promise = api.GET('/me');

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(calls).toBe(2);
    expect(result.response.status).toBe(200);
  });
});

describe('R61: transient refresh failures (network error, 5xx, malformed body) never log out', () => {
  it('a 5xx from /auth/refresh rejects the original request without touching the session', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) return new Response('', { status: 503 });
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await expect(api.GET('/me')).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });

    expect(session.get()).toBe('stale');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('a network error while refreshing rejects the original request without touching the session', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) throw new TypeError('network error');
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await expect(api.GET('/me')).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });

    expect(session.get()).toBe('stale');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('a malformed (non-JSON) 200 body from /auth/refresh is also transient, not a logout', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) return new Response('not json', { status: 200 });
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await expect(api.GET('/me')).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });

    expect(session.get()).toBe('stale');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('Minor C: a 200 from /auth/refresh with no string accessToken is transient too — never set/broadcast', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/refresh')) return jsonResponse({ expiresIn: 900 });
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await expect(api.GET('/me')).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });

    expect(session.get()).toBe('stale');
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});

describe('Minors A/B: second-401 handling never clobbers a newer token, and dedupes onAuthLost', () => {
  it('Minor A: does not null a token that something else already moved past while the retry was in flight', async () => {
    const session = createMemoryTokenStore('stale');
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/refresh')) return jsonResponse({ accessToken: 'fresh1', expiresIn: 900 });
      const token = requestHeaders(input, init).get('Authorization');
      if (token === 'Bearer fresh1') {
        session.set('fresh2');
        return afterMs(50, problemResponse({ code: 'UNAUTHORIZED' }, 401));
      }
      return problemResponse({ code: 'UNAUTHORIZED' }, 401);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    const promise = api.GET('/me');
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(session.get()).toBe('fresh2');
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(result.response.status).toBe(401);
  });

  it('Minor B: onAuthLost fires at most once per dead token, even across separate later calls that find the same still-dead token', async () => {
    const session = createMemoryTokenStore(null);
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn(async () => problemResponse({ code: 'TOKEN_EXPIRED' }, 401));
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock, onAuthLost });

    await api.refresh();
    await vi.advanceTimersByTimeAsync(50);
    await api.refresh();
    await vi.advanceTimersByTimeAsync(50);

    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });
});

describe('Api.dispose()', () => {
  it('closes the BroadcastChannel this client opened, without throwing', () => {
    const session = createMemoryTokenStore('abc');
    const api = createApi({ baseUrl: BASE_URL, session, fetch: vi.fn() });

    expect(() => api.dispose()).not.toThrow();
    expect(() => api.dispose()).not.toThrow();
  });
});
