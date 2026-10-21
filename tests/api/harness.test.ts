/**
 * Meta-tests of the harness itself (no backend needed): the contract validator must reject what the contract
 * forbids, otherwise every other suite would pass vacuously.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CookieJar, type ApiResponse } from './lib/client.js';
import { contract, expectContract, expectProblem, expectSharedResponse } from './lib/contract.js';
import { demoUser } from './lib/auth.js';
import { API_BACKEND } from './lib/env.js';

function fake(over: Partial<ApiResponse> & { json?: unknown; headers?: Headers }): ApiResponse {
  const text = over.json === undefined ? (over.text ?? '') : JSON.stringify(over.json);
  const headers =
    over.headers ??
    new Headers({
      'content-type': 'application/json; charset=utf-8',
      'x-backend': API_BACKEND,
      'x-request-id': '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    });
  const contentType = (headers.get('content-type') ?? '').split(';')[0]!.trim();
  return {
    method: 'GET',
    path: '/health/live',
    status: 200,
    headers,
    contentType,
    body: over.json ?? (text || null),
    text,
    bytes: Buffer.from(text),
    ...over,
  };
}

describe('expectContract (meta)', () => {
  it('accepts a response the contract allows', async () => {
    await expect(expectContract(fake({ json: { status: 'ok' } }), 'getHealthLive')).resolves.toBeTruthy();
  });

  it('rejects an extra property (additionalProperties: false)', async () => {
    await expect(expectContract(fake({ json: { status: 'ok', extra: 1 } }), 'getHealthLive')).rejects.toThrow(
      /additional properties/,
    );
  });

  it('rejects a wrong value (const) and a missing required property', async () => {
    await expect(expectContract(fake({ json: { status: 'fine' } }), 'getHealthLive')).rejects.toThrow(
      /constant/,
    );
    await expect(
      expectContract(fake({ path: '/health/ready', json: { status: 'ok' } }), 'getHealthReady'),
    ).rejects.toThrow(/required property 'checks'/);
  });

  it('rejects an undeclared status', async () => {
    await expect(
      expectContract(fake({ status: 418, json: { status: 'ok' } }), 'getHealthLive'),
    ).rejects.toThrow(/status 418 is not declared/);
  });

  it('rejects an undeclared media type and a non-JSON body', async () => {
    const headers = new Headers({
      'content-type': 'text/plain',
      'x-backend': API_BACKEND,
      'x-request-id': 'r-1',
    });
    await expect(expectContract(fake({ headers, text: 'ok' }), 'getHealthLive')).rejects.toThrow(
      /Content-Type "text\/plain" is not declared/,
    );
  });

  it('validates the body of a $ref response (components.responses) and its media type', async () => {
    const problem = {
      type: '/problems/validation',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION',
    };
    const headers = new Headers({
      'content-type': 'application/problem+json',
      'x-backend': API_BACKEND,
      'x-request-id': 'abc',
    });
    await expect(
      expectContract(
        fake({ method: 'POST', path: '/auth/login', status: 400, headers, json: problem }),
        'login',
      ),
    ).resolves.toBeTruthy();
    await expect(
      expectContract(
        fake({
          method: 'POST',
          path: '/auth/login',
          status: 400,
          headers,
          json: { ...problem, code: 'OOPS' },
        }),
        'login',
      ),
    ).rejects.toThrow(/body\/code must be equal to one of the allowed values/);
  });

  it('rejects a wrong or missing X-Backend and an invalid X-Request-Id on any response', async () => {
    const other = API_BACKEND === 'express' ? 'django' : 'express';
    const h = (b: string | null, r: string | null) => {
      const x = new Headers({ 'content-type': 'application/json' });
      if (b) x.set('x-backend', b);
      if (r) x.set('x-request-id', r);
      return x;
    };
    const body = { status: 'ok' };
    await expect(
      expectContract(fake({ headers: h(other, 'r'), json: body }), 'getHealthLive'),
    ).rejects.toThrow(/X-Backend is "django"|X-Backend is "express"/);
    await expect(
      expectContract(fake({ headers: h(null, 'r'), json: body }), 'getHealthLive'),
    ).rejects.toThrow(/X-Backend is null/);
    await expect(
      expectContract(fake({ headers: h(API_BACKEND, 'has space'), json: body }), 'getHealthLive'),
    ).rejects.toThrow(/X-Request-Id/);
  });

  it('checks declared header schemas (Idempotent-Replayed is "true"|"false")', async () => {
    const c = await contract();
    const op = [...c.ops.values()].find((o) => {
      const r = o.op.responses?.['201'] ?? o.op.responses?.['200'];
      return r?.headers?.['Idempotent-Replayed'];
    })!;
    const code = op.op.responses['201'] ? 201 : 200;
    const headers = new Headers({
      'content-type': 'application/json',
      'x-backend': API_BACKEND,
      'x-request-id': 'r',
      'idempotent-replayed': 'yes',
    });
    await expect(expectContract(fake({ status: code, headers, json: {} }), op.operationId)).rejects.toThrow(
      /header Idempotent-Replayed/,
    );
  });

  it('rejects a body on a response that declares none', async () => {
    const c = await contract();
    const op = [...c.ops.values()].find((o) => o.op.responses?.['204'] && !o.op.responses['204'].content)!;
    await expect(expectContract(fake({ status: 204, json: { a: 1 } }), op.operationId)).rejects.toThrow(
      /declares none/,
    );
  });
});

describe('problem consistency in expectContract (meta, fix round 1 I3)', () => {
  const headers = () =>
    new Headers({
      'content-type': 'application/problem+json',
      'x-backend': API_BACKEND,
      'x-request-id': 'r',
    });
  const login400 = (json: object) =>
    expectContract(
      fake({ method: 'POST', path: '/auth/login', status: 400, headers: headers(), json }),
      'login',
    );
  const ok = { type: '/problems/validation', title: 'Validation failed', status: 400, code: 'VALIDATION' };

  it('accepts a problem whose status and type agree with the response and its code', async () => {
    await expect(login400(ok)).resolves.toBeTruthy();
  });

  it('rejects body.status different from the HTTP status', async () => {
    await expect(login400({ ...ok, status: 422 })).rejects.toThrow(/body.status 422 != HTTP status 400/);
  });

  it('rejects a type that is not /problems/<kebab(code)> (schema-valid but inconsistent)', async () => {
    await expect(login400({ ...ok, type: '/problems/not-found' })).rejects.toThrow(
      /body.type \/problems\/not-found != \/problems\/validation/,
    );
    await expect(login400({ ...ok, code: 'RATE_LIMITED' })).rejects.toThrow(/!= \/problems\/rate-limited/);
  });
});

describe('expectProblem (meta)', () => {
  const headers = () =>
    new Headers({
      'content-type': 'application/problem+json',
      'x-backend': API_BACKEND,
      'x-request-id': 'r',
    });
  const nf = { type: '/problems/not-found', title: 'Not found', status: 404, code: 'NOT_FOUND' };

  it('accepts a contract Problem with the expected status and code', async () => {
    await expect(
      expectProblem(fake({ status: 404, headers: headers(), json: nf }), 404, 'NOT_FOUND'),
    ).resolves.toBe(undefined);
  });

  it('rejects a type that does not follow the code, a foreign code, and extra members', async () => {
    const bad = [
      { ...nf, type: '/problems/notfound' },
      { ...nf, code: 'NOPE' },
      { ...nf, stack: 'Error: at …' },
    ];
    for (const json of bad)
      await expect(
        expectProblem(fake({ status: 404, headers: headers(), json }), 404, 'NOT_FOUND'),
      ).rejects.toThrow();
  });
});

describe('expectSharedResponse (meta)', () => {
  const body = {
    type: '/problems/method-not-allowed',
    title: 'Method not allowed',
    status: 405,
    code: 'METHOD_NOT_ALLOWED',
  };
  const headers = (allow: string | null) => {
    const h = new Headers({
      'content-type': 'application/problem+json',
      'x-backend': API_BACKEND,
      'x-request-id': 'r',
    });
    if (allow !== null) h.set('allow', allow);
    return h;
  };
  const check = (allow: string | null, json: object = body) =>
    expectSharedResponse(fake({ status: 405, headers: headers(allow), json }), 'MethodNotAllowed', {
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
    });

  it('accepts a 405 METHOD_NOT_ALLOWED problem with a valid Allow header', async () => {
    await expect(check('GET, POST')).resolves.toBe(undefined);
  });

  it('rejects a missing or malformed Allow header and a different code', async () => {
    await expect(check(null)).rejects.toThrow(/required header Allow is missing/);
    await expect(check('get')).rejects.toThrow(/header Allow/);
    await expect(check('GET', { ...body, code: 'NOT_FOUND', type: '/problems/not-found' })).rejects.toThrow(
      /body.code NOT_FOUND/,
    );
  });
});

describe('CookieJar (meta)', () => {
  it('sends a cookie only under its Path and forgets it on Max-Age=0', () => {
    const jar = new CookieJar();
    jar.store(
      ['at_refresh=abc; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600'],
      '/api/v1/auth/login',
    );
    expect(jar.header('/api/v1/auth/refresh')).toBe('at_refresh=abc');
    expect(jar.header('/api/v1/auth')).toBe('at_refresh=abc');
    expect(jar.header('/api/v1/authx')).toBeNull();
    expect(jar.header('/api/v1/me')).toBeNull();
    jar.store(['at_refresh=; Path=/api/v1/auth; Max-Age=0'], '/api/v1/auth/logout');
    expect(jar.header('/api/v1/auth/refresh')).toBeNull();
  });

  it('honours Expires and the default path', () => {
    const jar = new CookieJar();
    const now = Date.parse('2026-09-25T00:00:00Z');
    jar.store(['a=1; Expires=Fri, 25 Sep 2026 00:00:10 GMT', 'b=2'], '/api/v1/auth/login', now);
    expect(jar.header('/api/v1/auth/x', now)).toBe('a=1; b=2');
    expect(jar.header('/api/v1/auth/x', now + 11_000)).toBe('b=2');
    expect(jar.header('/api/v1/me', now)).toBeNull();
  });
});

describe('demo users (meta)', () => {
  it('picks org heads and employees per role from the seed data', () => {
    expect(demoUser('FARMER', { head: true }).email).toBe('zarya.head@agrotrace.test');
    expect(demoUser('FARMER', { head: false }).isOrgAdmin).toBe(false);
    expect(demoUser('INSPECTOR').roles).toContain('INSPECTOR');
    expect(() => demoUser('ADMIN', { key: 'petrov' })).toThrow(/no demo user/);
  });
});

describe('backend-neutral suite (P58)', () => {
  it('no test pins a backend name: the expected one comes from lib/env.ts (API_BACKEND)', () => {
    const root = import.meta.dirname;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (n === 'node_modules') return [];
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    const pinned = walk(root)
      .map((f) => relative(root, f).replaceAll('\\', '/'))
      .filter((f) => f !== 'lib/env.ts' && f !== 'harness.test.ts')
      .filter((f) => /['"`](express|django|laravel)['"`]/.test(readFileSync(join(root, f), 'utf8')));
    expect(pinned).toEqual([]);
  });
});
