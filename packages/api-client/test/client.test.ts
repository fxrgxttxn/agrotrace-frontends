import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createApi, newIdempotencyKey, withVariant } from '../src/client';
import { createMemoryTokenStore } from '../src/session';
import { jsonResponse, noContentResponse, problemResponse, requestCredentials, requestHeaders, requestUrl } from './helpers';

const BASE_URL = 'http://localhost/api/v1';

const ME_BODY = {
  id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  email: 'petrov@kfh-petrov.ru',
  fullName: 'Петров Иван Сергеевич',
  roles: ['FARMER'],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('sends credentials: include only for /auth/refresh and /auth/logout', async () => {
    const session = createMemoryTokenStore('abc123');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).endsWith('/auth/logout')) return noContentResponse();
      return jsonResponse(ME_BODY);
    });
    const api = createApi({ baseUrl: BASE_URL, session, fetch: fetchMock });

    await api.GET('/me');
    await api.POST('/auth/logout');

    const [meInput, meInit] = fetchMock.mock.calls[0]!;
    const [logoutInput, logoutInit] = fetchMock.mock.calls[1]!;
    expect(requestCredentials(meInput, meInit)).not.toBe('include');
    expect(requestCredentials(logoutInput, logoutInit)).toBe('include');
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
    // Only one refresh attempt for the one request, and no infinite retry loop.
    const refreshCalls = fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/auth/refresh'));
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
      if (calls === 1) return problemResponse({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' }, 409, { 'Retry-After': '1' });
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

    // 1 initial attempt + 5 retries = 6 calls total, then it gives up and returns the 409.
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
    expect(withVariant('/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a', '96')).toBe(
      '/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a?variant=96',
    );
  });

  it('sets variant without touching exp/sig on a signed URL', () => {
    const signed = '/api/v1/files/3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f?exp=1790247600&sig=9f2c4e6a';
    const result = withVariant(signed, '480');
    const [, query] = result.split('?');
    const params = new URLSearchParams(query);
    expect(params.get('exp')).toBe('1790247600');
    expect(params.get('sig')).toBe('9f2c4e6a');
    expect(params.get('variant')).toBe('480');
  });

  it('replaces an existing variant instead of duplicating it', () => {
    const url = '/api/v1/files/id?exp=1&sig=abc&variant=96';
    const result = withVariant(url, '480');
    const params = new URLSearchParams(result.split('?')[1]);
    expect(params.getAll('variant')).toEqual(['480']);
  });
});
