/**
 * Cross-backend interoperability (spec §14.1 «Кросс-backend», contract info.description: a token, file or
 * notification created by one implementation is accepted by any other). Every scenario runs in both directions of
 * the pair (A → B and B → A) from CROSS_API_URLS; nothing here names a backend (P58) — the expected `X-Backend` of
 * each response comes from the URL of the side that answered.
 *
 * - Argon2id: a password hashed by one backend (registration, accepted invitation) verifies on the other;
 * - signed file URLs: a URL issued by one backend downloads through the other, same bytes and ETag, 304 on match;
 * - Idempotency-Key: a request executed on one backend replays on the other (same answer, Idempotent-Replayed);
 * - SSE: a notification created by an operation on one backend reaches a stream held on the other;
 * - JWT/refresh: a refresh token rotated or revoked on one backend is refused by the other.
 *
 * On main the pair is Express with itself; the ports run it as `./at cross:test <a> <b>` in both orders.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import users from '../../db/seed/data/users.json' with { type: 'json' };
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';
import { A, B, SAME_BACKEND, type Target } from './lib/backends.js';
import { call, type Session } from './lib/http.js';
import { filePart, mailedToken, openStream, send, type Stream } from './lib/stand.js';

const demo = (pred: (u: { roles: string[]; isOrgAdmin: boolean; key: string }) => boolean) =>
  (users as { key: string; email: string; roles: string[]; isOrgAdmin: boolean }[]).find(pred)!;
const ADMIN = demo((u) => u.roles.includes('ADMIN') && u.isOrgAdmin);
const PETROV = demo((u) => u.key === 'petrov');
const PASSWORD = 'Ozimaya-2026!';
const PNG = readFileSync(new URL('../api/fixtures/landscape-640x320.png', import.meta.url));
const DIRECTIONS: [string, Target, Target][] = [
  ['A → B', A, B],
  ['B → A', B, A],
];

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const unique = (p: string) =>
  `${p}.${Date.now().toString(36)}${randomBytes(3).toString('hex')}@agrotrace.test`;
const idemKey = () => `k-${randomBytes(12).toString('hex')}`;

function expectFrom(res: { status: number; headers: Headers; body?: unknown }, t: Target, status: number) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers.get('x-backend')).toBe(t.backend);
}

/** A random INN with a valid FNS checksum (R66). */
function randomInn(): string {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const d = [...randomBytes(9)].map((b) => b % 10);
  return [...d, (w.reduce((s, k, i) => s + k * d[i]!, 0) % 11) % 10].join('');
}

async function login(t: Target, email: string, password: string): Promise<{ token: string; userId: string }> {
  const res = await send(t, 'POST', '/auth/login', { json: { email, password } });
  expectFrom(res, t, 200);
  expect(res.body.twoFactorRequired).toBe(false);
  return { token: res.body.accessToken as string, userId: res.body.user.id as string };
}

let admin: string;
/** registerOrganization on `on` (the head's password is hashed there), approveOrganization as ADMIN. */
async function activeOrg(on: Target, type: 'FARM' | 'PROCESSOR') {
  const email = unique(type.toLowerCase());
  const reg = await send(on, 'POST', '/auth/register-organization', {
    json: {
      inn: randomInn(),
      type,
      name: `Кросс-организация ${randomBytes(3).toString('hex')}`,
      regionCode: '33',
      admin: { email, fullName: 'Кроссов Тест Тестович', password: PASSWORD },
    },
  });
  expectFrom(reg, on, 201);
  const orgId = reg.body.organizationId as string;
  const ok = await send(on, 'POST', `/admin/organizations/${orgId}/approve`, { token: admin });
  expectFrom(ok, on, 200);
  expect(ok.body.status).toBe('ACTIVE');
  return { orgId, email };
}

let receiver: { orgId: string; token: string };
let farm: { token: string; fieldId: string; wheatId: string };
const streams: Stream[] = [];

beforeAll(async () => {
  admin = (await login(A, ADMIN.email, DEMO_PASSWORD)).token;
  const proc = await activeOrg(A, 'PROCESSOR');
  receiver = { orgId: proc.orgId, token: (await login(B, proc.email, PASSWORD)).token };
  const petrov = (await login(A, PETROV.email, DEMO_PASSWORD)).token;
  const field = await send(A, 'POST', '/fields', {
    token: petrov,
    json: { name: `Кросс-участок ${randomBytes(2).toString('hex')}`, areaHa: '10.00', regionCode: '33' },
  });
  expectFrom(field, A, 201);
  let wheatId: string | undefined;
  for (let page = 1; !wheatId; page++) {
    const res = await send(B, 'GET', `/dictionaries/products?size=100&page=${page}`, { token: petrov });
    expectFrom(res, B, 200);
    wheatId = (res.body.items as { id: string; name: string; category: string }[]).find(
      (p) => p.category === 'GRAIN' && p.name === 'Пшеница мягкая',
    )?.id;
    if (!wheatId && page * 100 >= res.body.total) throw new Error('no seeded wheat');
  }
  farm = { token: petrov, fieldId: field.body.id as string, wheatId };
});

afterAll(() => {
  for (const s of streams.splice(0)) s.close();
});

/** An Approved raw batch of «КФХ Петров» created on `on` (retries the 20 % lab sample, which goes OnTest). */
async function approvedBatch(on: Target): Promise<{ id: string; massKg: string }> {
  for (let i = 0; i < 15; i++) {
    const res = await send(on, 'POST', '/batches', {
      token: farm.token,
      json: {
        fieldId: farm.fieldId,
        productId: farm.wheatId,
        massKg: '1000.000',
        harvestedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    expectFrom(res, on, 201);
    if (res.body.status === 'Approved') return res.body;
  }
  throw new Error('no Approved batch after 15 attempts');
}

const waybillBody = (b: { id: string; massKg: string }) => ({
  receiverOrgId: receiver.orgId,
  items: [{ batchId: b.id, massDeclaredKg: b.massKg }],
});

describe(`interop across backends: ${A.backend} ↔ ${B.backend}${SAME_BACKEND ? ' (same-backend pair)' : ''}`, () => {
  it('P58: the scenarios never name a backend (the expected one comes from CROSS_API_URLS)', () => {
    const dir = new URL('./', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.ts'))) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/['"`](express|django|laravel)['"`]/);
    }
  });

  it.each(DIRECTIONS)(
    'Argon2id %s: a password hashed by one backend verifies on the other',
    async (_, x, y) => {
      // registerOrganization on x hashes the head's password; y verifies it.
      const org = await activeOrg(x, 'PROCESSOR');
      const head = await login(y, org.email, PASSWORD);
      // inviteUser + acceptInvite on y hash the employee's password; x verifies it and refuses a wrong one.
      const email = unique('invited');
      const inv = await send(y, 'POST', '/users', {
        token: head.token,
        json: { email, fullName: 'Приглашённый Кроссов', roles: ['PROCESSOR'], isOrgAdmin: false },
      });
      expectFrom(inv, y, 201);
      const token = await mailedToken(email, 'invite');
      const acc = await send(y, 'POST', '/auth/accept-invite', {
        json: { token, fullName: 'Сотрудник Кроссов', password: PASSWORD },
      });
      expectFrom(acc, y, 204);
      const employee = await login(x, email, PASSWORD);
      expect(employee.userId).toBe(inv.body.id);
      const wrong = await send(x, 'POST', '/auth/login', { json: { email, password: `${PASSWORD}x` } });
      expectFrom(wrong, x, 401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    },
  );

  it.each(DIRECTIONS)(
    'signed file URL %s: issued by one backend, downloaded through the other — same bytes and ETag, 304 on match',
    async (_, x, y) => {
      const { body, contentType } = filePart(PNG, 'cross.png', 'image/png');
      const up = await send(x, 'PUT', '/me/avatar', { token: receiver.token, body, contentType });
      expectFrom(up, x, 200);
      const path = (up.body.url as string).replace(/^\/api\/v1/, '');
      expect(path).toMatch(/^\/files\/[0-9a-f-]{36}\?.*sig=[0-9a-f]{64}/);
      // No Bearer: only the signature of x grants access on y.
      const there = await send(y, 'GET', path);
      expectFrom(there, y, 200);
      expect(there.headers.get('content-type')).toMatch(/^image\/webp/);
      const etag = there.headers.get('etag');
      expect(etag).toBe(`"${sha256(there.bytes)}"`);
      const here = await send(x, 'GET', path);
      expectFrom(here, x, 200);
      expect(here.headers.get('etag')).toBe(etag);
      expect(here.bytes.equals(there.bytes)).toBe(true);
      const cached = await send(y, 'GET', path, { headers: { 'if-none-match': etag! } });
      expectFrom(cached, y, 304);
      expect(cached.bytes.length).toBe(0);
      // A tampered signature is refused by the other backend too.
      const forged = await send(
        y,
        'GET',
        path.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`),
      );
      expectFrom(forged, y, 403);
    },
  );

  it.each(DIRECTIONS)(
    'Idempotency-Key %s: executed on one backend, replayed by the other; another request with the key → REUSED',
    async (_, x, y) => {
      const b = await approvedBatch(x);
      const key = idemKey();
      const body = waybillBody(b);
      const first = await send(x, 'POST', '/waybills', {
        token: farm.token,
        json: body,
        headers: { 'idempotency-key': key },
      });
      expectFrom(first, x, 201);
      expect(first.headers.get('idempotent-replayed')).not.toBe('true');
      const again = await send(y, 'POST', '/waybills', {
        token: farm.token,
        json: body,
        headers: { 'idempotency-key': key },
      });
      expectFrom(again, y, 201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      const changed = { ...body, items: [{ ...body.items[0]!, massDeclaredKg: '999.000' }] };
      const reused = await send(y, 'POST', '/waybills', {
        token: farm.token,
        json: changed,
        headers: { 'idempotency-key': key },
      });
      expectFrom(reused, y, 409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    },
  );

  it.each(DIRECTIONS)(
    'SSE %s: a notification created through one backend reaches a stream held on the other',
    async (_, x, y) => {
      const s = await openStream(y, receiver.token);
      streams.push(s);
      expectFrom(s, y, 200);
      await s.next('unread');
      // sendWaybill on x → notification.dispatch (x's worker) → IN_APP row → NOTIFY → y's LISTEN → y's stream.
      const b = await approvedBatch(x);
      const draft = await send(x, 'POST', '/waybills', {
        token: farm.token,
        json: waybillBody(b),
        headers: { 'idempotency-key': idemKey() },
      });
      expectFrom(draft, x, 201);
      const sent = await send(x, 'POST', `/waybills/${draft.body.id}/send`, {
        token: farm.token,
        headers: { 'idempotency-key': idemKey(), 'if-match': String(draft.body.version) },
      });
      expectFrom(sent, x, 200);
      const n = await s.next('notification', (e) => e.data?.payload?.waybillId === draft.body.id);
      expect(n.data.type).toBe('WAYBILL_INCOMING');
      expect(n.id).toBe(String(n.data.seq));
      s.close();
    },
  );

  it.each(DIRECTIONS)(
    'JWT/refresh %s: a token rotated or revoked on one backend is refused by the other',
    async (_, x, y) => {
      const s: Session = { accessToken: null, refresh: null };
      const start = await call(x, s, 'POST', '/auth/login', { email: PETROV.email, password: DEMO_PASSWORD });
      expectFrom(start, x, 200);
      const issued = s.refresh!;
      const rotated = await call(y, s, 'POST', '/auth/refresh');
      expectFrom(rotated, y, 200);
      expect(s.refresh).not.toBe(issued);
      const meOnX = await send(x, 'GET', '/me', { token: rotated.body!.accessToken as string });
      expectFrom(meOnX, x, 200);
      // The rotated-away token is refused where it was issued.
      const stale = await call(x, { accessToken: null, refresh: issued }, 'POST', '/auth/refresh');
      expectFrom(stale, x, 401);
      // Logout on x revokes the token y issued; y refuses it afterwards.
      const out = await call(x, { accessToken: null, refresh: s.refresh }, 'POST', '/auth/logout');
      expectFrom(out, x, 204);
      const revoked = await call(y, { accessToken: null, refresh: s.refresh }, 'POST', '/auth/refresh');
      expectFrom(revoked, y, 401);
    },
  );
});
