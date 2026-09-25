/**
 * Auth pieces that tests/api cannot observe over HTTP on the dev stack: the DaData adapter (no key there, so the found
 * / not-found / retry paths never run), TOTP against the RFC 6238 vectors, the file-URL signature against the
 * contract's worked example, JWT claim checks, the client-IP normalization and the refresh-cookie parser.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createDaData, type DaData, type PartyLookup } from '../src/infra/dadata.js';
import { AppProblem } from '../src/http/problem.js';
import { registrationIdentity } from '../src/modules/auth/registration.js';
import { createFileUrls, fileUrlKey, fileSignature } from '../src/infra/file-urls.js';
import { clientIp } from '../src/http/request-id.js';
import { issueAccessToken, verifyAccessToken } from '../src/security/jwt.js';
import { matchStep } from '../src/security/totp.js';
import { refreshCookieOf } from '../src/modules/auth/sessions.js';
import { memoryLogger } from './helpers.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DaData adapter', () => {
  const opts = { apiKey: 'k', url: 'http://dadata.test/party', timeoutMs: 50 };

  it('no API key → unavailable without any request', async () => {
    let calls = 0;
    const d = createDaData({ ...opts, apiKey: undefined }, memoryLogger().logger, async () => {
      calls++;
      return json(200, {});
    });
    expect(await d.findParty('2311123457')).toEqual({ status: 'unavailable' });
    expect(calls).toBe(0);
  });

  it('found → short name with OPF and address; the request carries the key and the INN', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const d = createDaData(opts, memoryLogger().logger, async (url, init) => {
      seen = { url: String(url), init: init! };
      return json(200, {
        suggestions: [
          {
            value: 'КФХ Петров',
            data: {
              name: { short_with_opf: 'КФХ Петров И.С.' },
              address: { value: 'г. Владимир, ул. Мира, 1' },
            },
          },
        ],
      });
    });
    expect(await d.findParty('2311123457')).toEqual({
      status: 'found',
      name: 'КФХ Петров И.С.',
      address: 'г. Владимир, ул. Мира, 1',
    });
    expect(seen!.url).toBe(opts.url);
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Token k');
    expect(JSON.parse(seen!.init.body as string)).toEqual({ query: '2311123457', count: 1 });
  });

  it('empty suggestions → notFound', async () => {
    const d = createDaData(opts, memoryLogger().logger, async () => json(200, { suggestions: [] }));
    expect(await d.findParty('2311123457')).toEqual({ status: 'notFound' });
  });

  it('5xx / network errors / timeouts are retried 3 times, then unavailable; 4xx is not retried', async () => {
    let calls = 0;
    const flaky = createDaData(
      opts,
      memoryLogger().logger,
      async () => {
        calls++;
        if (calls === 1) return json(502, {});
        if (calls === 2) throw new TypeError('fetch failed');
        return json(200, { suggestions: [{ value: 'ООО Ромашка' }] });
      },
      1,
    );
    expect(await flaky.findParty('2311123457')).toEqual({
      status: 'found',
      name: 'ООО Ромашка',
      address: null,
    });
    expect(calls).toBe(3);

    calls = 0;
    const slow = createDaData(
      opts,
      memoryLogger().logger,
      (_url, init) => {
        calls++;
        return new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))),
        );
      },
      1,
    );
    expect(await slow.findParty('2311123457')).toEqual({ status: 'unavailable' });
    expect(calls).toBe(3);

    calls = 0;
    const denied = createDaData(
      opts,
      memoryLogger().logger,
      async () => {
        calls++;
        return json(403, {});
      },
      1,
    );
    expect(await denied.findParty('2311123457')).toEqual({ status: 'unavailable' });
    expect(calls).toBe(1);
  });
});

describe('TOTP (RFC 6238 appendix B, SHA1, truncated to 6 digits)', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  it('matches the vectors and reports the step, ±1 step accepted, ±2 not', () => {
    expect(matchStep(secret, '287082', 59_000)).toBe(1);
    expect(matchStep(secret, '081804', 1111111109_000)).toBe(37037036);
    // 081804 belongs to step 37037036: seen from the neighbouring steps it is still accepted …
    expect(matchStep(secret, '081804', (37037036 + 1) * 30_000 + 5_000)).toBe(37037036);
    expect(matchStep(secret, '081804', (37037036 - 1) * 30_000 + 5_000)).toBe(37037036);
    // … but not from two steps away.
    expect(matchStep(secret, '081804', (37037036 + 2) * 30_000 + 5_000)).toBeNull();
    expect(matchStep(secret, '000000', 59_000)).toBeNull();
  });
});

describe('signed file URLs (contract GET /files/{id}, R88 M2)', () => {
  it('reproduces the worked example of the contract', () => {
    const key = fileUrlKey('dev_only_change_me_32_bytes_minimum_xx');
    expect(key.toString('hex')).toBe('ecedca06a78414e48b66ba0a401a61401c7f8af078b2fc35c8dfe5017e7a4a70');
    expect(fileSignature(key, '3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f', 1790247600)).toBe(
      '9de1ced479cc0f1c78c9d8deff00f42955b37d6a7cb19f9635a07a6300c29ee0',
    );
  });

  it('signed() → /api/v1/files/{id}?exp=now+3600&sig=…, verify() accepts it until exp', () => {
    const urls = createFileUrls('dev_only_change_me_32_bytes_minimum_xx');
    const now = new Date(1790244000_000);
    const url = urls.signed('3C9D7E1F-2A4B-4C6D-8E0F-1A2B3C4D5E6F', now);
    expect(url).toBe(
      '/api/v1/files/3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f?exp=1790247600&sig=9de1ced479cc0f1c78c9d8deff00f42955b37d6a7cb19f9635a07a6300c29ee0',
    );
    const sig = url.split('sig=')[1]!;
    expect(urls.verify('3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f', 1790247600, sig, now)).toBe(true);
    expect(
      urls.verify('3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f', 1790247600, sig, new Date(1790247601_000)),
    ).toBe(false);
    expect(urls.verify('3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f', 1790247601, sig, now)).toBe(false);
  });
});

describe('access tokens', () => {
  const secret = 'x'.repeat(32);
  const p = { userId: 'u-1', orgId: 'o-1', roles: ['FARMER' as const], orgAdmin: true };

  it('issue → verify round trip; claims sub/org/roles/org_admin/iat/exp(+900)/jti', async () => {
    const token = await issueAccessToken(secret, p, new Date());
    expect(await verifyAccessToken(secret, token)).toEqual(p);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'jti', 'org', 'org_admin', 'roles', 'sub']);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('rejects expired, foreign, alg≠HS256 and malformed-claim tokens', async () => {
    const past = await issueAccessToken(secret, p, new Date(Date.now() - 3600_000));
    expect(await verifyAccessToken(secret, past)).toBeNull();
    expect(await verifyAccessToken('y'.repeat(32), await issueAccessToken(secret, p))).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({ org: 'o', roles: ['FARMER'], org_admin: false })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u')
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(secret));
    expect(await verifyAccessToken(secret, hs512)).toBeNull();
    const badRole = await new SignJWT({ org: 'o', roles: ['ROOT'], org_admin: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(secret));
    expect(await verifyAccessToken(secret, badRole)).toBeNull();
    expect(await verifyAccessToken(secret, 'a.b.c')).toBeNull();
  });
});

describe('small parsers', () => {
  it('clientIp: IPv4-mapped IPv6 → IPv4; non-IP → null', () => {
    expect(clientIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp('evil, 1.2.3.4')).toBeNull();
    expect(clientIp(undefined)).toBeNull();
  });

  it('refreshCookieOf picks at_refresh among other cookies', () => {
    expect(refreshCookieOf('a=1; at_refresh=tok_en-1; b=2')).toBe('tok_en-1');
    expect(refreshCookieOf('at_refresh=')).toBeNull();
    expect(refreshCookieOf('other=1')).toBeNull();
    expect(refreshCookieOf(undefined)).toBeNull();
  });
});

describe('registration × DaData (registrationIdentity with a stub adapter)', () => {
  const stub = (r: PartyLookup): DaData => ({ findParty: async () => r });
  const decide = async (d: DaData, name?: string) =>
    registrationIdentity(await d.findParty('2311123457'), name);

  it('found → PENDING with the name and address from DaData, whatever the request says', async () => {
    expect(
      await decide(stub({ status: 'found', name: 'ООО «Ромашка»', address: 'г. Владимир' }), 'Другое'),
    ).toEqual({ name: 'ООО «Ромашка»', address: 'г. Владимир', status: 'PENDING' });
  });

  it('notFound → 400 errors.inn [validation.inn.notFound]', async () => {
    const err = await decide(stub({ status: 'notFound' }), 'КФХ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppProblem);
    expect((err as AppProblem).body()).toMatchObject({
      status: 400,
      code: 'VALIDATION',
      errors: { inn: ['validation.inn.notFound'] },
    });
  });

  it('unavailable → MANUAL_CHECK with the request name; without a name → errors.name [validation.required]', async () => {
    expect(await decide(stub({ status: 'unavailable' }), 'КФХ Петров')).toEqual({
      name: 'КФХ Петров',
      address: null,
      status: 'MANUAL_CHECK',
    });
    const err = await decide(stub({ status: 'unavailable' })).catch((e: unknown) => e);
    expect((err as AppProblem).body().errors).toEqual({ name: ['validation.required'] });
  });
});
