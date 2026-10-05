import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiProblem, createPublicApi, retryAfterOf, withVariant } from '../src/public';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status < 300 ? 'application/json' : 'application/problem+json', ...headers },
  });

describe('createPublicApi', () => {
  it('GET /public/batches/{code}, the code path-encoded, no request id (the gateway assigns it)', async () => {
    const fetch = vi.fn(async () => json(200, { publicCode: 'AT-2026-000123' }));
    const api = createPublicApi({ fetch });
    expect(await api.getBatch('AT-2026-000123')).toEqual({ publicCode: 'AT-2026-000123' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/public/batches/AT-2026-000123');
    expect(new Headers(init.headers).get('X-Request-Id')).toBeNull();
    await api.getBatch('a/b');
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe('/api/v1/public/batches/a%2Fb');
  });

  it('POST a complaint as JSON; GET the captcha with no-store', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/captcha') ? json(200, { algorithm: 'SHA-256' }) : json(201, { id: 'x' }),
    );
    const api = createPublicApi({ fetch, baseUrl: '/base' });
    await api.createComplaint('AT-2026-000123', { text: 'Горечь во рту', altcha: 'p' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/base/public/batches/AT-2026-000123/complaints');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Горечь во рту', altcha: 'p' });
    await api.getCaptcha();
    const [curl, cinit] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(curl).toBe('/base/public/captcha');
    expect(cinit.cache).toBe('no-store');
  });

  it('a problem answer throws ApiProblem; Retry-After of a 429 is kept', async () => {
    const problem = { type: '/problems/rate-limited', title: 'Too many', status: 429, code: 'RATE_LIMITED' };
    const api = createPublicApi({ fetch: async () => json(429, problem, { 'Retry-After': '42' }) });
    const e = await api.createComplaint('AT-2026-000123', { text: 'x', altcha: 'p' }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e.status).toBe(429);
    expect(e.code).toBe('RATE_LIMITED');
    expect(retryAfterOf(e)).toBe(42);
  });

  it('a non-problem error body is a transient problem with the status; a network failure rejects as is', async () => {
    const api = createPublicApi({
      fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });
    const e = await api.getBatch('AT-2026-000123').catch((x) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e.status).toBe(502);
    expect(e.code).toBe('BACKEND_UNAVAILABLE');
    expect(retryAfterOf(e)).toBeNull();
    const down = createPublicApi({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(down.getBatch('AT-2026-000123')).rejects.toBeInstanceOf(TypeError);
  });

  it('withVariant is the same helper as the main entry', () => {
    expect(withVariant('/api/v1/public/files/x', 480)).toBe('/api/v1/public/files/x?variant=480');
  });

  it('imports neither openapi-fetch nor the session client', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/public.ts', import.meta.url)), 'utf8');
    const imports = src.split('\n').filter((l) => /^(import|export) .* from /.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join('\n')).not.toMatch(/openapi-fetch|'\.\/(client|sse|session)'/);
  });
});
