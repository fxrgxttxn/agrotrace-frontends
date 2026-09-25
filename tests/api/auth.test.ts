/**
 * Auth (contracts/openapi/paths/auth.yaml): login order R31, lockout, 2FA R35, refresh rotation/grace/reuse R32/R40,
 * logout, password reset and invitations (R82 keys), registration (R29/R66), rate limits R30, Bearer auth.
 *
 * Fixture writes (lib/db.ts fixtureWrite) are used only for states no API produces yet — organization approval
 * (Task 4), blocking a user / invitations (Task 3) — or clocks too long to wait for (a 15-minute lockout); each site
 * says which. Redis keys are touched only in the formats the contract fixes (info.description "Shared Redis keys").
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { demoUser, demoUsers, loginAs, type Role } from './lib/auth.js';
import { api, ApiClient, type ApiResponse } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, fixtureWrite } from './lib/db.js';
import {
  activateOrg,
  activeOrgHead,
  breakChecksum,
  freshHead,
  login,
  PASSWORD,
  randomInn,
  registerOrg,
  uniqueEmail,
} from './lib/fixtures.js';
import { linkToken, mailsTo, waitForMails } from './lib/mail.js';
import { awayFromWindowEdge, closeRedis, redis, sha256hex, windowStart } from './lib/redis.js';
import { itRateLimit } from './lib/tags.js';
import { awayFromStepEdge, currentStep, totpAt } from './lib/totp.js';
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const REFRESH_MAX_AGE = 1209600;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface ParsedCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
}

function parseSetCookie(line: string): ParsedCookie {
  const [pair = '', ...rest] = line.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf('=');
    attrs.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? '' : a.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

const refreshCookies = (res: ApiResponse) =>
  res.headers
    .getSetCookie()
    .map(parseSetCookie)
    .filter((c) => c.name === 'at_refresh');

function expectCookieAttrs(c: ParsedCookie, maxAge: number): void {
  expect(c.attrs.get('max-age')).toBe(String(maxAge));
  expect(c.attrs.get('path')).toBe('/api/v1/auth');
  expect(c.attrs.has('httponly')).toBe(true);
  expect(c.attrs.has('secure')).toBe(true);
  expect(c.attrs.get('samesite')?.toLowerCase()).toBe('strict');
}

/** The one `at_refresh` cookie a successful login/refresh sets; returns the token. */
function expectRefreshCookie(res: ApiResponse): string {
  const cookies = refreshCookies(res);
  expect(cookies, 'exactly one at_refresh Set-Cookie').toHaveLength(1);
  expectCookieAttrs(cookies[0]!, REFRESH_MAX_AGE);
  expect(cookies[0]!.value.length).toBeGreaterThanOrEqual(32);
  return cookies[0]!.value;
}

function expectClearedCookie(res: ApiResponse): void {
  const cookies = refreshCookies(res);
  expect(cookies, 'exactly one at_refresh Set-Cookie (deletion)').toHaveLength(1);
  expect(cookies[0]!.value).toBe('');
  expectCookieAttrs(cookies[0]!, 0);
}

const expectNoCookie = (res: ApiResponse) => expect(res.headers.getSetCookie()).toEqual([]);

function expectProblem(res: ApiResponse, status: number, code: string): void {
  expect(res.status, res.text).toBe(status);
  expect(res.body.code, res.text).toBe(code);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JWT payload
function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}
/**
 * A JWT over `payload` with the given JOSE header (default HS256), HMAC-signed with `secret` using the hash the
 * header names for HS* (HS256 for any other `alg`, i.e. an alg-confusion attempt); `alg: none` → empty signature.
 */
function signJwt(
  payload: Record<string, unknown>,
  secret = process.env.JWT_SECRET!,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  if (header.alg === 'none') return `${head}.${body}.`;
  const hash = header.alg === 'HS512' ? 'sha512' : header.alg === 'HS384' ? 'sha384' : 'sha256';
  const sig = createHmac(hash, secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const refresh = (client: ApiClient, token?: string) =>
  client.post(
    '/auth/refresh',
    undefined,
    token === undefined ? {} : { headers: { cookie: `at_refresh=${token}` } },
  );

async function refreshOk(client: ApiClient, token: string): Promise<string> {
  const res = await refresh(client, token);
  await expectContract(res, 'refreshToken');
  expect(res.status, res.text).toBe(200);
  expect(res.body.expiresIn).toBe(900);
  return expectRefreshCookie(res);
}

/** Login that must succeed without TOTP; returns the response and the refresh token. */
async function loginOk(client: ApiClient, email: string, password: string) {
  const res = await login(client, email, password);
  expect(res.status, res.text).toBe(200);
  expect(res.body.twoFactorRequired).toBe(false);
  return { res, token: expectRefreshCookie(res) };
}

// TODO(Task 3): block/unblock through PATCH /users/{id} (updateUser) once it exists.
const setUserStatus = (email: string, status: 'ACTIVE' | 'BLOCKED' | 'INVITED') =>
  fixtureWrite(`UPDATE users SET status = $2 WHERE email = $1`, [email, status]);

// TODO(Task 4): suspend through updateAdminOrganization once it exists.
const setOrgStatus = (id: string, status: string) =>
  fixtureWrite(`UPDATE organizations SET status = $2 WHERE id = $1`, [id, status]);

// ── login ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('login', () => {
  for (const role of ROLES) {
    it(`a ${role} signs in: LoginSuccess, claims, refresh cookie`, async () => {
      const u = demoUser(role);
      const client = api();
      const { res } = await loginOk(client, u.email, DEMO_PASSWORD);
      expect(res.body.user.email).toBe(u.email);
      expect(res.body.user.roles).toEqual(expect.arrayContaining([role]));
      expect(res.body.user.isOrgAdmin).toBe(u.isOrgAdmin);
      const claims = jwtPayload(res.body.accessToken);
      expect(claims.sub).toBe(res.body.user.id);
      expect(claims.org).toBe(res.body.user.organization.id);
      expect([...claims.roles].sort()).toEqual([...res.body.user.roles].sort());
      expect(claims.org_admin).toBe(u.isOrgAdmin);
      expect(claims.exp - claims.iat).toBe(900);
      expect(typeof claims.jti).toBe('string');
      expect(Math.abs(claims.iat - Date.now() / 1000)).toBeLessThan(30);
    });
  }

  it('email is case-insensitive; the response carries it in lower case', async () => {
    const u = demoUsers[0]!;
    const { res } = await loginOk(api(), u.email.toUpperCase(), DEMO_PASSWORD);
    expect(res.body.user.email).toBe(u.email);
  });

  it('unknown email → 401 INVALID_CREDENTIALS, never ACCOUNT_LOCKED', async () => {
    const client = api();
    const email = uniqueEmail('nobody');
    for (let i = 0; i < 6; i++) {
      const res = await login(client, email, 'whatever-password');
      expectProblem(res, 401, 'INVALID_CREDENTIALS');
      expectNoCookie(res);
    }
  });

  it('R31 under concurrency: a right password racing the locking 5th wrong one is never let in once the lock is set', async () => {
    // 4 wrong passwords first, then the 5th wrong and the right one in parallel. Either the right one resets the
    // counter first (the 5th wrong then counts 1, no lock, the right one is 200), or the 5th wrong locks first and the
    // right one must be ACCOUNT_LOCKED — the account state afterwards tells which happened. Never both.
    for (let round = 0; round < 4; round++) {
      const org = await activeOrgHead();
      for (let i = 1; i <= 4; i++) await login(api(), org.email, `wrong-${i}-password`);
      const [, right] = await Promise.all([
        login(api(), org.email, 'wrong-5-password'),
        login(api(), org.email, org.password),
      ]);
      const after = await login(api(), org.email, org.password);
      if (after.status === 401) {
        expectProblem(after, 401, 'ACCOUNT_LOCKED');
        expectProblem(right, 401, 'ACCOUNT_LOCKED'); // never 200 (or 403) from a burst that locked the account
      } else {
        expect(after.status, after.text).toBe(200);
        expect(right.status, right.text).toBe(200);
      }
    }
  });

  it('5 wrong passwords lock for 15 minutes; locked → ACCOUNT_LOCKED even with the right password, not extended', async () => {
    const org = await activeOrgHead();
    const client = api();
    for (let i = 1; i <= 4; i++)
      expectProblem(await login(client, org.email, `wrong-${i}-password`), 401, 'INVALID_CREDENTIALS');
    const before = Date.now();
    const locked = await login(client, org.email, 'wrong-5-password');
    expectProblem(locked, 401, 'ACCOUNT_LOCKED');
    const until = Date.parse(locked.body.params.lockedUntil);
    expect(locked.body.params.lockedUntil).toMatch(/Z$/);
    expect(until - before).toBeGreaterThan(15 * 60_000 - 30_000);
    expect(until - before).toBeLessThan(15 * 60_000 + 30_000);

    const right = await login(client, org.email, org.password);
    expectProblem(right, 401, 'ACCOUNT_LOCKED');
    expect(right.body.params.lockedUntil).toBe(locked.body.params.lockedUntil);
    expectNoCookie(right);
    const wrongAgain = await login(client, org.email, 'wrong-6-password');
    expectProblem(wrongAgain, 401, 'ACCOUNT_LOCKED');
    expect(wrongAgain.body.params.lockedUntil).toBe(locked.body.params.lockedUntil);

    // The 15-minute window cannot be waited out in a test: move the lock into the past (fixture clock).
    await fixtureWrite(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`, [
      org.email,
    ]);
    // The counter restarted at the lock: four more wrong passwords do not lock again.
    for (let i = 1; i <= 4; i++)
      expectProblem(await login(client, org.email, `again-${i}-password`), 401, 'INVALID_CREDENTIALS');
    await loginOk(client, org.email, org.password);
  });

  it('a correct password resets the failure counter', async () => {
    const org = await activeOrgHead();
    const client = api();
    for (let i = 1; i <= 4; i++)
      expectProblem(await login(client, org.email, `wrong-${i}-password`), 401, 'INVALID_CREDENTIALS');
    await loginOk(client, org.email, org.password);
    for (let i = 1; i <= 4; i++)
      expectProblem(await login(client, org.email, `wrong-${i}-password`), 401, 'INVALID_CREDENTIALS');
  });

  it('password first, then statuses: 403 ORGANIZATION_NOT_ACTIVE / USER_BLOCKED / USER_INVITED', async () => {
    const org = await registerOrg('FARM'); // not approved: MANUAL_CHECK
    const client = api();
    expectProblem(await login(client, org.email, 'wrong-password-1'), 401, 'INVALID_CREDENTIALS');
    const pending = await login(client, org.email, org.password);
    expectProblem(pending, 403, 'FORBIDDEN');
    expect(pending.body.params).toEqual({ reason: 'ORGANIZATION_NOT_ACTIVE' });
    expectNoCookie(pending);

    await activateOrg(org.organizationId);
    await setUserStatus(org.email, 'BLOCKED');
    const blocked = await login(client, org.email, org.password);
    expectProblem(blocked, 403, 'FORBIDDEN');
    expect(blocked.body.params).toEqual({ reason: 'USER_BLOCKED' });

    await setUserStatus(org.email, 'INVITED');
    const invited = await login(client, org.email, org.password);
    expectProblem(invited, 403, 'FORBIDDEN');
    expect(invited.body.params).toEqual({ reason: 'USER_INVITED' });

    await setUserStatus(org.email, 'ACTIVE');
    await loginOk(client, org.email, org.password);
  });

  it('an invalid body → 400 VALIDATION with field errors', async () => {
    const client = api();
    const missing = await client.post('/auth/login', { email: 'a@b.ru' });
    await expectContract(missing, 'login');
    expectProblem(missing, 400, 'VALIDATION');
    expect(missing.body.errors.password).toEqual(['validation.required']);
    const extra = await client.post('/auth/login', { email: 'a@b.ru', password: 'x', remember: true });
    expectProblem(extra, 400, 'VALIDATION');
    expect(extra.body.errors.remember).toEqual(['validation.unknownField']);
    const email = await client.post('/auth/login', { email: 'not-an-email', password: 'x' });
    expectProblem(email, 400, 'VALIDATION');
    expect(Object.keys(email.body.errors)).toEqual(['email']);
  });

  itRateLimit(
    'login-ip: the 21st attempt from one IP within the window → 429 with Retry-After and params',
    async () => {
      await awayFromWindowEdge(60, 20);
      const client = api();
      // P9: only the last X-Forwarded-For entry (appended by the gateway) is the client; what a client puts left of it
      // is ignored. A fresh spoofed address per run so its (absent) counter is not shared with earlier runs.
      const ip = client.clientIp;
      const spoofed = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
      client.clientIp = `${spoofed}, ${ip}`;
      const email = uniqueEmail('ratelimit');
      for (let i = 0; i < 20; i++)
        expectProblem(await login(client, email, 'some-password'), 401, 'INVALID_CREDENTIALS');
      const u = demoUsers[0]!;
      const limited = await login(client, u.email, DEMO_PASSWORD); // the limit comes first (R31 step 1)
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(limited.body.params).toEqual({ scope: 'login-ip', limit: 20, windowSec: 60 });
      const retry = Number(limited.headers.get('retry-after'));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(60);
      expectNoCookie(limited);
      const count = await redis().get(`rl:login-ip:${ip}:${windowStart(60)}`);
      expect(Number(count)).toBeGreaterThanOrEqual(21);
      expect(await redis().exists(`rl:login-ip:${spoofed}:${windowStart(60)}`)).toBe(0);
      // Another address is not affected.
      await loginOk(api(), u.email, DEMO_PASSWORD);
    },
  );
});

// ── Bearer authentication ───────────────────────────────────────────────────────────────────────────────────────

describe('Bearer access token', () => {
  it('missing, malformed, foreign-signed or expired → 401 UNAUTHORIZED', async () => {
    const { user } = await freshHead('AUTHORITY');
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: user.id,
      org: randomUUID(),
      roles: ['INSPECTOR'],
      org_admin: true,
      jti: randomUUID(),
    };
    const cases: Record<string, string | undefined> = {
      missing: undefined,
      malformed: 'Bearer not-a-jwt',
      basic: 'Basic dXNlcjpwYXNz',
      foreign: `Bearer ${signJwt({ ...claims, iat: now, exp: now + 900 }, 'another_secret_of_at_least_32_bytes!!')}`,
      expired: `Bearer ${signJwt({ ...claims, iat: now - 1000, exp: now - 100 })}`,
    };
    for (const [name, header] of Object.entries(cases)) {
      const res = await api().post(
        '/auth/2fa/setup',
        {},
        { headers: header ? { authorization: header } : {} },
      );
      await expectContract(res, 'setupTwoFactor');
      expect(res.status, `${name}: ${res.text}`).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    }
  });

  it('a token signed with the shared JWT_SECRET is accepted (any backend issues it)', async () => {
    const { user, client } = await freshHead('AUTHORITY');
    const now = Math.floor(Date.now() / 1000);
    const own = jwtPayload(client.accessToken!);
    const token = signJwt({ ...own, jti: randomUUID(), iat: now, exp: now + 900 });
    const res = await api().post('/auth/2fa/setup', {}, { headers: { authorization: `Bearer ${token}` } });
    await expectContract(res, 'setupTwoFactor');
    expect(res.status, res.text).toBe(200);
    expect(own.sub).toBe(user.id);
  });

  it('alg confusion and claim tampering → 401 (only HS256 with valid claims is accepted)', async () => {
    const { client } = await freshHead('AUTHORITY');
    const now = Math.floor(Date.now() / 1000);
    const own = jwtPayload(client.accessToken!);
    const valid = { ...own, jti: randomUUID(), iat: now, exp: now + 900 };
    const without = (k: string) => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== k));
    const [h, , s] = client.accessToken!.split('.');
    const tampered = `${h}.${b64url(JSON.stringify({ ...own, roles: ['ADMIN'] }))}.${s}`;
    const cases: Record<string, string> = {
      'alg none': signJwt(valid, undefined, { alg: 'none', typ: 'JWT' }),
      'alg none, HS256 signature kept': `${b64url(JSON.stringify({ alg: 'none' }))}.${signJwt(valid).split('.').slice(1).join('.')}`,
      HS512: signJwt(valid, undefined, { alg: 'HS512', typ: 'JWT' }),
      'RS256 header, HMAC with the secret': signJwt(valid, undefined, { alg: 'RS256', typ: 'JWT' }),
      'roles tampered, original signature': tampered,
      'no sub': signJwt(without('sub')),
      'no org': signJwt(without('org')),
      'no exp': signJwt(without('exp')),
      'org_admin as a string': signJwt({ ...valid, org_admin: 'true' }),
      'unknown role': signJwt({ ...valid, roles: ['ROOT'] }),
      'unknown crit header': signJwt(valid, undefined, {
        alg: 'HS256',
        typ: 'JWT',
        crit: ['x-at'],
        'x-at': 1,
      }),
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await api().post('/auth/2fa/setup', {}, { headers: { authorization: `Bearer ${token}` } });
      await expectContract(res, 'setupTwoFactor');
      expect(res.status, `${name}: ${res.text}`).toBe(401);
      expect(res.body.code, name).toBe('UNAUTHORIZED');
    }
    // Control: the same claims, properly signed, are accepted.
    const ok = await api().post(
      '/auth/2fa/setup',
      {},
      { headers: { authorization: `Bearer ${signJwt(valid)}` } },
    );
    expect(ok.status, ok.text).toBe(200);
  });

  it('x-roles: a role outside [INSPECTOR, ADMIN] → 403 FORBIDDEN without params', async () => {
    const { client } = await freshHead('FARM');
    const res = await client.post('/auth/2fa/setup', {});
    await expectContract(res, 'setupTwoFactor');
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body.params).toBeUndefined();
  });

  itRateLimit("scope 'user': the 101st authenticated request within the window → 429", async () => {
    // A demo employee, not a registration: the --ratelimits run is the plain backend, where DaData may be configured.
    const client = await loginAs('FARMER', { head: false });
    const user = { id: jwtPayload(client.accessToken!).sub as string };
    await awayFromWindowEdge(60, 20);
    const results = await Promise.all(Array.from({ length: 100 }, () => client.post('/auth/2fa/setup', {})));
    expect(results.map((r) => r.status)).toEqual(Array(100).fill(403));
    const limited = await client.post('/auth/2fa/setup', {});
    await expectContract(limited, 'setupTwoFactor');
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(limited.body.params).toEqual({ scope: 'user', limit: 100, windowSec: 60 });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(await redis().get(`rl:user:${user.id}:${windowStart(60)}`))).toBeGreaterThanOrEqual(101);
  });
});

// ── 2FA ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A fresh INSPECTOR (head of a new AUTHORITY) with TOTP enabled by the code of step now+`offset` (±1 is accepted by
 * the setup too); `usedStep` — that step, which is never accepted again. A test that later needs step now−1 enables
 * with +1 and vice versa, so the two never collide within the ~30 s a test takes.
 */
async function inspectorWithTotp(offset: -1 | 0 | 1 = 0) {
  const { org, client, user } = await freshHead('AUTHORITY');
  const start = await client.post('/auth/2fa/setup', {});
  await expectContract(start, 'setupTwoFactor');
  expect(start.status, start.text).toBe(200);
  const secret = start.body.secret as string;
  await awayFromStepEdge(4);
  const usedStep = currentStep() + offset;
  const confirm = await client.post('/auth/2fa/setup', { code: totpAt(secret, usedStep) });
  await expectContract(confirm, 'setupTwoFactor');
  expect(confirm.status, confirm.text).toBe(200);
  expect(confirm.body).toEqual({ totpEnabled: true });
  return { org, client, user, secret, usedStep };
}

async function challenge(email: string, password = PASSWORD): Promise<string> {
  const res = await login(api(), email, password);
  expect(res.status, res.text).toBe(200);
  expect(res.body.twoFactorRequired).toBe(true);
  return res.body.challengeId as string;
}

const verify = async (challengeId: string, code: string, client = api()) => {
  const res = await client.post('/auth/2fa/verify', { challengeId, code });
  await expectContract(res, 'verifyTwoFactor');
  return res;
};

describe('two-factor setup', () => {
  it('two steps: secret, then a code enables TOTP; repeated start replaces the secret; enabled → 409', async () => {
    const { org, client } = await freshHead('AUTHORITY');
    const early = await client.post('/auth/2fa/setup', { code: '123456' });
    await expectContract(early, 'setupTwoFactor');
    expectProblem(early, 400, 'INVALID_TWO_FACTOR_CODE');

    const first = await client.post('/auth/2fa/setup', {});
    await expectContract(first, 'setupTwoFactor');
    expect(first.status).toBe(200);
    expect(first.body.totpEnabled).toBe(false);
    const url = new URL(first.body.otpauthUrl);
    expect(url.searchParams.get('secret')).toBe(first.body.secret);
    expect(url.searchParams.get('issuer')).toBe('AgroTrace');
    expect(decodeURIComponent(url.pathname)).toContain(org.email);

    const second = await client.post('/auth/2fa/setup', {});
    expect(second.status).toBe(200);
    expect(second.body.secret).not.toBe(first.body.secret);

    await awayFromStepEdge(4);
    const step = currentStep();
    const stale = await client.post('/auth/2fa/setup', { code: totpAt(first.body.secret, step) });
    expectProblem(stale, 400, 'INVALID_TWO_FACTOR_CODE');
    const bad = await client.post('/auth/2fa/setup', { code: totpAt(second.body.secret, step + 5) });
    expectProblem(bad, 400, 'INVALID_TWO_FACTOR_CODE');
    const invalid = await client.post('/auth/2fa/setup', { code: '12345' });
    expectProblem(invalid, 400, 'VALIDATION');
    expect(invalid.body.errors.code).toBeDefined();

    const ok = await client.post('/auth/2fa/setup', { code: totpAt(second.body.secret, step) });
    await expectContract(ok, 'setupTwoFactor');
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ totpEnabled: true });

    for (const body of [{}, { code: totpAt(second.body.secret, step + 1) }]) {
      const again = await client.post('/auth/2fa/setup', body);
      await expectContract(again, 'setupTwoFactor');
      expectProblem(again, 409, 'INVALID_TRANSITION');
      expect(again.body.params.from).toBe('ENABLED');
    }
  });
});

describe('two-factor login', () => {
  it('login returns a challenge (no tokens, no cookie) stored as 2fa:{challengeId} for 5 minutes', async () => {
    const { org, user } = await inspectorWithTotp();
    const res = await login(api(), org.email, org.password);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ twoFactorRequired: true, challengeId: expect.any(String) });
    expectNoCookie(res);
    const key = `2fa:${res.body.challengeId}`;
    const value = JSON.parse((await redis().get(key))!);
    expect(value.userId).toBe(user.id);
    expect(value.exp - Date.now() / 1000).toBeGreaterThan(290);
    expect(value.exp - Date.now() / 1000).toBeLessThanOrEqual(301);
    const ttl = await redis().ttl(key);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('the step accepted by the setup is refused; step +1 accepted; the challenge is single-use', async () => {
    const { org, secret, usedStep, user } = await inspectorWithTotp(-1);
    expect(await redis().get(`totp-used:${user.id}:${usedStep}`)).toBe('1');
    expect(await redis().ttl(`totp-used:${user.id}:${usedStep}`)).toBeLessThanOrEqual(90);
    const id = await challenge(org.email);
    const reused = await verify(id, totpAt(secret, usedStep));
    expectProblem(reused, 401, 'INVALID_TWO_FACTOR_CODE');
    expect(reused.body.params).toEqual({ attemptsLeft: 4 });

    await awayFromStepEdge(4);
    const client = api();
    const ok = await verify(id, totpAt(secret, currentStep() + 1), client);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.twoFactorRequired).toBe(false);
    expect(ok.body.user.totpEnabled).toBe(true);
    expect(jwtPayload(ok.body.accessToken).sub).toBe(user.id);
    await refreshOk(client, expectRefreshCookie(ok));
    expect(await redis().exists(`2fa:${id}`)).toBe(0);

    const again = await verify(id, totpAt(secret, currentStep()));
    expectProblem(again, 401, 'TOKEN_EXPIRED');
  });

  it('step −1 is accepted', async () => {
    const { org, secret } = await inspectorWithTotp(1);
    const id = await challenge(org.email);
    await awayFromStepEdge(4);
    const ok = await verify(id, totpAt(secret, currentStep() - 1));
    expect(ok.status, ok.text).toBe(200);
    expectRefreshCookie(ok);
  });

  it('±2 steps are refused; 5 wrong codes annul the challenge; wrong codes do not touch the lockout', async () => {
    const { org, secret } = await inspectorWithTotp();
    const id = await challenge(org.email);
    await awayFromStepEdge(4);
    const s = currentStep();
    const attempts = [totpAt(secret, s + 2), totpAt(secret, s - 2), '000000', '999999'].map((c) =>
      c === totpAt(secret, s) || c === totpAt(secret, s - 1) || c === totpAt(secret, s + 1) ? '111111' : c,
    );
    let left = 4;
    for (const code of attempts) {
      const res = await verify(id, code);
      expectProblem(res, 401, 'INVALID_TWO_FACTOR_CODE');
      expect(res.body.params).toEqual({ attemptsLeft: left });
      left -= 1;
    }
    const fifth = await verify(id, attempts[0]!);
    expectProblem(fifth, 401, 'INVALID_TWO_FACTOR_CODE');
    expect(fifth.body.params).toEqual({ attemptsLeft: 0 });
    expect(await redis().exists(`2fa:${id}`, `2fa-fail:${id}`)).toBe(0);
    const annulled = await verify(id, totpAt(secret, currentStep()));
    expectProblem(annulled, 401, 'TOKEN_EXPIRED');
    // The password is still accepted (5 wrong codes are not 5 wrong passwords).
    await challenge(org.email);
  });

  it('a parallel burst of wrong codes gets at most 5 INVALID_TWO_FACTOR_CODE answers per challenge', async () => {
    const { org } = await inspectorWithTotp();
    const id = await challenge(org.email);
    const results = await Promise.all(Array.from({ length: 8 }, () => verify(id, '000000')));
    const invalid = results.filter((r) => r.body.code === 'INVALID_TWO_FACTOR_CODE');
    expect(invalid.length).toBeLessThanOrEqual(5);
    for (const r of results) expect(r.status).toBe(401);
    expect(results.filter((r) => r.body.code === 'TOKEN_EXPIRED').length).toBe(8 - invalid.length);
    expect(new Set(invalid.map((r) => r.body.params.attemptsLeft)).size).toBe(invalid.length);
  });

  it('a right code on an expired challenge does not burn its step: it still works on a new challenge', async () => {
    const { org, secret } = await inspectorWithTotp(-1);
    const id = await challenge(org.email);
    await redis().del(`2fa:${id}`); // the challenge expired
    await awayFromStepEdge(6);
    const code = totpAt(secret, currentStep());
    expectProblem(await verify(id, code), 401, 'TOKEN_EXPIRED');
    const ok = await verify(await challenge(org.email), code);
    expect(ok.status, ok.text).toBe(200);
  });

  it('an unknown or expired challenge → 401 TOKEN_EXPIRED; a malformed body → 400', async () => {
    const { org, secret } = await inspectorWithTotp();
    expectProblem(await verify(randomUUID(), '123456'), 401, 'TOKEN_EXPIRED');
    const id = await challenge(org.email);
    // Stands in for the 5-minute TTL: the contract's key disappears.
    await redis().del(`2fa:${id}`);
    await awayFromStepEdge(4);
    expectProblem(await verify(id, totpAt(secret, currentStep() + 1)), 401, 'TOKEN_EXPIRED');
    const bad = await api().post('/auth/2fa/verify', { challengeId: 'nope', code: '12' });
    await expectContract(bad, 'verifyTwoFactor');
    expectProblem(bad, 400, 'VALIDATION');
    expect(Object.keys(bad.body.errors).sort()).toEqual(['challengeId', 'code']);
  });
});

// ── refresh & logout ─────────────────────────────────────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('rotates: a new access token and a new cookie each time', async () => {
    const { org, client } = await freshHead('FARM');
    const { token: a } = await loginOk(client, org.email, org.password);
    const b = await refreshOk(client, a);
    expect(b).not.toBe(a);
    const c = await refreshOk(client, b);
    expect(c).not.toBe(b);
    // The cookie jar path works too (the browser's view).
    const viaJar = await refresh(client);
    await expectContract(viaJar, 'refreshToken');
    expect(viaJar.status).toBe(200);
    const res = await refresh(client, a); // long rotated, but only ~seconds ago → grace
    await expectContract(res, 'refreshToken');
    expectProblem(res, 401, 'TOKEN_EXPIRED');
    const claims = jwtPayload(viaJar.body.accessToken);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('parallel refreshes with one token: exactly one rotates, the others are the grace 401; the chain lives', async () => {
    const { org } = await freshHead('FARM');
    const client = api();
    const { token: a } = await loginOk(client, org.email, org.password);
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(api(), a)));
    for (const r of results) await expectContract(r, 'refreshToken');
    const winners = results.filter((r) => r.status === 200);
    expect(winners, results.map((r) => r.status).join(',')).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expectProblem(r, 401, 'TOKEN_EXPIRED');
      expectNoCookie(r);
    }
    await refreshOk(client, expectRefreshCookie(winners[0]!));
  });

  it('a token rotated ≤ 10 s ago → 401 without Set-Cookie and without revoking the chain', async () => {
    const { org } = await freshHead('FARM');
    const client = api();
    const { token: a } = await loginOk(client, org.email, org.password);
    const b = await refreshOk(client, a);
    const race = await refresh(client, a);
    await expectContract(race, 'refreshToken');
    expectProblem(race, 401, 'TOKEN_EXPIRED');
    expectNoCookie(race);
    await refreshOk(client, b);
  });

  it('reuse of a token rotated > 10 s ago revokes its chain only; other sessions live', async () => {
    const { org } = await freshHead('FARM');
    const one = api();
    const other = api();
    const { token: a } = await loginOk(one, org.email, org.password);
    const { token: x } = await loginOk(other, org.email, org.password);
    const b = await refreshOk(one, a);
    await new Promise((r) => setTimeout(r, 11_000)); // R32: the grace window is 10 s
    const reuse = await refresh(one, a);
    await expectContract(reuse, 'refreshToken');
    expectProblem(reuse, 401, 'TOKEN_EXPIRED');
    expectClearedCookie(reuse);
    const child = await refresh(one, b); // the chain's active token is revoked too
    await expectContract(child, 'refreshToken');
    expectProblem(child, 401, 'TOKEN_EXPIRED');
    expectClearedCookie(child);
    await refreshOk(other, x);
  }, 40_000);

  it('missing or unknown cookie → 401 TOKEN_EXPIRED and the cookie is deleted', async () => {
    for (const token of [undefined, b64url(randomBytes(32))]) {
      const res = await refresh(api(), token);
      await expectContract(res, 'refreshToken');
      expectProblem(res, 401, 'TOKEN_EXPIRED');
      expectClearedCookie(res);
    }
  });

  it('blocked user or inactive organization → 403 with reason, token revoked, cookie deleted', async () => {
    const { org } = await freshHead('FARM');
    const client = api();
    const { token: a } = await loginOk(client, org.email, org.password);
    await setUserStatus(org.email, 'BLOCKED');
    const blocked = await refresh(client, a);
    await expectContract(blocked, 'refreshToken');
    expectProblem(blocked, 403, 'FORBIDDEN');
    expect(blocked.body.params).toEqual({ reason: 'USER_BLOCKED' });
    expectClearedCookie(blocked);
    await setUserStatus(org.email, 'ACTIVE');
    expectProblem(await refresh(client, a), 401, 'TOKEN_EXPIRED');

    const { token: b } = await loginOk(client, org.email, org.password);
    await setOrgStatus(org.organizationId, 'SUSPENDED');
    const suspended = await refresh(client, b);
    await expectContract(suspended, 'refreshToken');
    expectProblem(suspended, 403, 'FORBIDDEN');
    expect(suspended.body.params).toEqual({ reason: 'ORGANIZATION_NOT_ACTIVE' });
    expectClearedCookie(suspended);
  });
});

describe('logout', () => {
  it('revokes the token and deletes the cookie; idempotent; the revoked token → 401 + cookie deleted', async () => {
    const { org } = await freshHead('FARM');
    const client = api();
    const other = api();
    const { token: a } = await loginOk(client, org.email, org.password);
    const { token: x } = await loginOk(other, org.email, org.password);
    const out = await client.post('/auth/logout', undefined, { headers: { cookie: `at_refresh=${a}` } });
    await expectContract(out, 'logout');
    expect(out.status).toBe(204);
    expectClearedCookie(out);
    const after = await refresh(client, a);
    await expectContract(after, 'refreshToken');
    expectProblem(after, 401, 'TOKEN_EXPIRED');
    expectClearedCookie(after);
    // No chain revocation for a logged-out token, other sessions untouched.
    await refreshOk(other, x);

    for (const headers of [{ cookie: `at_refresh=${a}` }, {} as Record<string, string>]) {
      const again = await api().post('/auth/logout', undefined, { headers });
      await expectContract(again, 'logout');
      expect(again.status).toBe(204);
      expectClearedCookie(again);
    }
  });
});

// ── password reset ───────────────────────────────────────────────────────────────────────────────────────────────

async function requestReset(email: string): Promise<{ token: string; url: string }> {
  const before = (await mailsTo(email)).length;
  const res = await api().post('/auth/password/forgot', { email });
  await expectContract(res, 'forgotPassword');
  expect(res.status, res.text).toBe(204);
  const [mail] = await waitForMails(email.toLowerCase(), before + 1);
  return linkToken(mail!, 'password/reset');
}

describe('password reset', () => {
  it('forgot → a letter with the link; pwreset:{sha256} holds {userId, exp} for an hour', async () => {
    const { org, user } = await freshHead('FARM');
    const { token, url } = await requestReset(org.email.toUpperCase());
    expect(url).toBe(`${process.env.PUBLIC_BASE_URL}/password/reset/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = `pwreset:${sha256hex(token)}`;
    const value = JSON.parse((await redis().get(key))!);
    expect(value).toEqual({ userId: user.id, exp: expect.any(Number) });
    expect(value.exp - Date.now() / 1000).toBeGreaterThan(3500);
    expect(value.exp - Date.now() / 1000).toBeLessThanOrEqual(3601);
    expect(await redis().ttl(key)).toBeGreaterThan(3500);
  });

  it('reset: invalid body keeps the token; valid → new password works, old one not, sessions revoked, lock lifted', async () => {
    const { org, client } = await freshHead('FARM');
    const { token: session } = await loginOk(client, org.email, org.password);
    for (let i = 1; i <= 5; i++) await login(api(), org.email, `wrong-${i}-password`); // locked now
    const { token } = await requestReset(org.email);

    const invalid = await api().post('/auth/password/reset', { token, password: 'short' });
    await expectContract(invalid, 'resetPassword');
    expectProblem(invalid, 400, 'VALIDATION');
    expect(invalid.body.errors.password).toBeDefined();
    expect(await redis().exists(`pwreset:${sha256hex(token)}`)).toBe(1);

    const newPassword = 'Novyi-parol 2026 ';
    const ok = await api().post('/auth/password/reset', { token, password: newPassword });
    await expectContract(ok, 'resetPassword');
    expect(ok.status, ok.text).toBe(204);

    expectProblem(await login(api(), org.email, org.password), 401, 'INVALID_CREDENTIALS');
    expectProblem(await login(api(), org.email, newPassword.trim()), 401, 'INVALID_CREDENTIALS'); // byte-exact
    await loginOk(api(), org.email, newPassword);
    expectProblem(await refresh(api(), session), 401, 'TOKEN_EXPIRED');

    const reused = await api().post('/auth/password/reset', { token, password: 'Another-pass-2026' });
    await expectContract(reused, 'resetPassword');
    expectProblem(reused, 400, 'TOKEN_EXPIRED');
  });

  it('unknown email → 204 and no letter; unknown token → 400 TOKEN_EXPIRED', async () => {
    const email = uniqueEmail('ghost');
    const res = await api().post('/auth/password/forgot', { email });
    await expectContract(res, 'forgotPassword');
    expect(res.status).toBe(204);
    // Barrier instead of a fixed wait: a later request for an existing account gets its letter (polled with a
    // deadline), so a letter to the unknown address, had one been sent first, would have arrived by now as well.
    const { org } = await freshHead('FARM');
    await requestReset(org.email);
    expect(await mailsTo(email)).toEqual([]);
    const reset = await api().post('/auth/password/reset', {
      token: b64url(randomBytes(32)),
      password: 'Some-password-1',
    });
    await expectContract(reset, 'resetPassword');
    expectProblem(reset, 400, 'TOKEN_EXPIRED');
    const invalid = await api().post('/auth/password/forgot', { email: 'nope' });
    await expectContract(invalid, 'forgotPassword');
    expectProblem(invalid, 400, 'VALIDATION');
  });

  itRateLimit(
    'forgot: the 4th request for one email within the hour → 429 (email lower-cased, existing or not)',
    async () => {
      await awayFromWindowEdge(3600, 30);
      const email = uniqueEmail('forgot');
      for (let i = 0; i < 3; i++) {
        const res = await api().post('/auth/password/forgot', {
          email: i === 1 ? email.toUpperCase() : email,
        });
        expect(res.status, res.text).toBe(204);
      }
      const limited = await api().post('/auth/password/forgot', { email: email.toUpperCase() });
      await expectContract(limited, 'forgotPassword');
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(limited.body.params).toEqual({ scope: 'forgot', limit: 3, windowSec: 3600 });
      const retry = Number(limited.headers.get('retry-after'));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(3600);
      expect(Number(await redis().get(`rl:forgot:${email}:${windowStart(3600)}`))).toBeGreaterThanOrEqual(4);
      // Another email is not affected.
      expect((await api().post('/auth/password/forgot', { email: uniqueEmail('forgot') })).status).toBe(204);
    },
  );
});

// ── registration ─────────────────────────────────────────────────────────────────────────────────────────────────

const registration = (over: Record<string, unknown> = {}, admin: Record<string, unknown> = {}) => ({
  inn: randomInn(),
  type: 'FARM',
  name: 'КФХ Тестовое',
  regionCode: '33',
  ...over,
  admin: { email: uniqueEmail('reg'), fullName: 'Тестов Тест', password: PASSWORD, ...admin },
});

async function register(body: unknown) {
  const res = await api().post('/auth/register-organization', body);
  await expectContract(res, 'registerOrganization');
  return res;
}

describe('registerOrganization', () => {
  it('DaData unavailable (the api-test profile unsets DADATA_API_KEY) → 201 MANUAL_CHECK; the head waits for approval', async () => {
    const body = registration({ inn: randomInn(12) }, { email: uniqueEmail('Mixed.Case').toUpperCase() });
    const res = await register(body);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toEqual({ organizationId: expect.any(String), status: 'MANUAL_CHECK' });
    const denied = await login(api(), body.admin.email as string, PASSWORD);
    expectProblem(denied, 403, 'FORBIDDEN');
    expect(denied.body.params.reason).toBe('ORGANIZATION_NOT_ACTIVE');
  });

  for (const [type, role] of [
    ['FARM', 'FARMER'],
    ['PROCESSOR', 'PROCESSOR'],
    ['LAB', 'LAB'],
    ['RETAILER', 'RETAILER'],
    ['AUTHORITY', 'INSPECTOR'],
  ] as const) {
    it(`${type}: the head gets role ${role} and isOrgAdmin`, async () => {
      const { org, client } = await freshHead(type);
      const res = await login(client, org.email.toUpperCase(), org.password);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        email: org.email,
        fullName: org.fullName,
        phone: null,
        avatarUrl: null,
        roles: [role],
        isOrgAdmin: true,
        totpEnabled: false,
        organization: { id: org.organizationId, type, logoUrl: null },
        channels: { email: true, telegram: false, telegramLinked: false },
      });
    });
  }

  it('INN checksum, taken INN/email, unknown region, missing name → 400 VALIDATION per field', async () => {
    const taken = await registerOrg('FARM');
    const checksum = await register(registration({ inn: breakChecksum(randomInn()) }));
    expectProblem(checksum, 400, 'VALIDATION');
    expect(checksum.body.errors).toEqual({ inn: ['validation.inn.checksum'] });

    const dup = await register(registration({ inn: taken.inn }, { email: taken.email.toUpperCase() }));
    expectProblem(dup, 400, 'VALIDATION');
    expect(dup.body.errors).toEqual({
      inn: ['validation.inn.taken'],
      'admin.email': ['validation.email.taken'],
    });

    const region = await register(registration({ regionCode: 'XX' }));
    expectProblem(region, 400, 'VALIDATION');
    expect(region.body.errors).toEqual({ regionCode: ['validation.notFound'] });

    const noName = registration();
    delete (noName as Record<string, unknown>).name;
    const unnamed = await register(noName);
    expectProblem(unnamed, 400, 'VALIDATION');
    expect(Object.keys(unnamed.body.errors)).toEqual(['name']);
  });

  it('schema: PLATFORM type, blank names, short password, unknown fields → 400', async () => {
    const res = await register({
      ...registration({ type: 'PLATFORM', name: '   ', extra: 1 }, { fullName: ' \t', password: 'short' }),
    });
    expectProblem(res, 400, 'VALIDATION');
    expect(Object.keys(res.body.errors).sort()).toEqual([
      'admin.fullName',
      'admin.password',
      'extra',
      'name',
      'type',
    ]);
  });
});

// ── invitations ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An INVITED employee of a fresh active organization and its invitation token.
 * TODO(Task 3): create through inviteUser (POST /users) and read the token from the letter; until then the user row
 * is a fixture write and the token is put under the contract's key `invite:{sha256hex(token)}` (R82).
 */
async function invitedUser() {
  const org = await activeOrgHead('FARM');
  const email = uniqueEmail('invited');
  const [row] = await fixtureWrite<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, full_name, status)
     VALUES ($1, $2, '!', $3, 'INVITED') RETURNING id`,
    [org.organizationId, email, email],
  );
  await fixtureWrite(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'FARMER'`,
    [row!.id],
  );
  const token = b64url(randomBytes(32));
  const exp = Math.floor(Date.now() / 1000) + 604800;
  await redis().set(`invite:${sha256hex(token)}`, JSON.stringify({ userId: row!.id, exp }), 'EX', 604800);
  return { org, email, userId: row!.id, token };
}

describe('acceptInvite', () => {
  it('invalid body keeps the token; then INVITED → ACTIVE with name and password; single use', async () => {
    const { email, token } = await invitedUser();
    expectProblem(await login(api(), email, 'Whatever-2026!'), 401, 'INVALID_CREDENTIALS');

    const invalid = await api().post('/auth/accept-invite', { token, fullName: '  ', password: PASSWORD });
    await expectContract(invalid, 'acceptInvite');
    expectProblem(invalid, 400, 'VALIDATION');
    expect(invalid.body.errors).toEqual({ fullName: ['validation.pattern'] });
    expect(await redis().exists(`invite:${sha256hex(token)}`)).toBe(1);

    const ok = await api().post('/auth/accept-invite', {
      token,
      fullName: 'Сидорова Анна Викторовна',
      password: 'Urozhai-2026!',
    });
    await expectContract(ok, 'acceptInvite');
    expect(ok.status, ok.text).toBe(204);
    expect(await redis().exists(`invite:${sha256hex(token)}`)).toBe(0);

    const { res } = await loginOk(api(), email, 'Urozhai-2026!');
    expect(res.body.user).toMatchObject({
      fullName: 'Сидорова Анна Викторовна',
      roles: ['FARMER'],
      isOrgAdmin: false,
    });

    const again = await api().post('/auth/accept-invite', {
      token,
      fullName: 'Другое Имя',
      password: 'Urozhai-2027!',
    });
    await expectContract(again, 'acceptInvite');
    expectProblem(again, 400, 'TOKEN_EXPIRED');
  });

  it('unknown token → 400 TOKEN_EXPIRED', async () => {
    const res = await api().post('/auth/accept-invite', {
      token: b64url(randomBytes(32)),
      fullName: 'Кто-то',
      password: PASSWORD,
    });
    await expectContract(res, 'acceptInvite');
    expectProblem(res, 400, 'TOKEN_EXPIRED');
  });
});
