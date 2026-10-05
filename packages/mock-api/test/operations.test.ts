import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/contract/operations.generated.js';
import { DEMO_PASSWORD, solveChallenge } from '../src/index.js';
import { BASE, call, coverage, expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const webp = new Uint8Array(readFileSync(new URL('../assets/seed/avatars/avatar-1-96.webp', import.meta.url)));
const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" onclick="x()" style="fill: red; background: url(http://e.x)" fill="url(http://evil)"/></svg>');
const svgScript = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const form = (bytes: Uint8Array, name: string, type = 'application/octet-stream'): FormData => {
  const f = new FormData();
  f.set('file', new File([bytes], name, { type }));
  return f;
};
const tokens = new Map<string, { token: string; at: number }>();
const as = async (email: string): Promise<string> => {
  const e = email.includes('@') ? email : `${email}@agrotrace.test`;
  const cached = tokens.get(e);
  if (!cached || mock.now() - cached.at > 14 * 60_000) tokens.set(e, { token: await mock.login(e), at: mock.now() });
  return tokens.get(e)!.token;
};
const code = (n: number) => `AT-2026-${String(n).padStart(6, '0')}`;
const batchId = (n: number) => mock.api.store.t.batches.find((b) => b.public_code === code(n))!.id;
const waybillId = (n: number) => mock.api.store.t.waybills.find((w) => w.number === `WB-2026-${String(n).padStart(6, '0')}`)!.id;
const org = (name: string) => mock.api.store.t.organizations.find((o) => o.name.includes(name))!;
const UNKNOWN = '00000000-0000-4000-8000-000000000001';

describe('generic protocol', () => {
  it('unknown path 404, undeclared method 405 with Allow, 401 without a token, 403 by role', async () => {
    const r = await call('GET', '/nope', { noValidate: true });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
    const m = await call('PUT', '/auth/login', { noValidate: true });
    expect(m.status).toBe(405);
    expect(m.headers.get('Allow')).toBe('POST');
    expect((await expectStatus(401, 'GET', '/me')).body.code).toBe('UNAUTHORIZED');
    expect((await expectStatus(401, 'GET', '/me', { token: 'a.b.c' })).body.code).toBe('UNAUTHORIZED');
    expect((await expectStatus(403, 'GET', '/fields', { token: await as('provizia.head') })).body).not.toHaveProperty('params');
    const bad = await expectStatus(400, 'PATCH', '/me', { token: await as('petrov'), rawBody: '{oops' });
    expect(bad.body.errors).toEqual({ _root: ['validation.invalid'] });
    const arr = await expectStatus(400, 'PATCH', '/me', { token: await as('petrov'), body: [1] });
    expect(arr.body.errors).toEqual({ _root: ['validation.type'] });
  });

  it('health', async () => {
    await expectStatus(200, 'GET', '/health/live');
    await expectStatus(200, 'GET', '/health/ready');
  });
});

describe('auth', () => {
  it('login, lockout, refresh rotation and reuse, logout', async () => {
    const wrong = await expectStatus(401, 'POST', '/auth/login', { body: { email: 'support@agrotrace.test', password: 'wrong-password' } });
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    await expectStatus(401, 'POST', '/auth/login', { body: { email: 'nobody@agrotrace.test', password: 'x' } });
    await expectStatus(400, 'POST', '/auth/login', { body: { email: 'not-an-email', password: 'x' } });
    for (let i = 0; i < 3; i++) await call('POST', '/auth/login', { body: { email: 'support@agrotrace.test', password: 'wrong-password' } });
    const locked = await expectStatus(401, 'POST', '/auth/login', { body: { email: 'support@agrotrace.test', password: 'wrong-password' } });
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    const stillLocked = await expectStatus(401, 'POST', '/auth/login', { body: { email: 'SUPPORT@agrotrace.test', password: DEMO_PASSWORD } });
    expect(stillLocked.body.params.lockedUntil).toBe(locked.body.params.lockedUntil);

    const ok = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } });
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(ok.body.user.roles).toEqual(['FARMER']);
    const cookie = /at_refresh=([^;]+)/.exec(ok.headers.get('set-cookie') ?? '')![1]!;
    const r1 = await expectStatus(200, 'POST', '/auth/refresh', { headers: { cookie: `at_refresh=${cookie}` } });
    const next = /at_refresh=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')![1]!;
    const race = await expectStatus(401, 'POST', '/auth/refresh', { headers: { cookie: `at_refresh=${cookie}` } });
    expect(race.headers.get('set-cookie')).toBeNull();
    mock.advance(11_000);
    const reuse = await expectStatus(401, 'POST', '/auth/refresh', { headers: { cookie: `at_refresh=${cookie}` } });
    expect(reuse.body.code).toBe('TOKEN_EXPIRED');
    await expectStatus(401, 'POST', '/auth/refresh', { headers: { cookie: `at_refresh=${next}` } });
    await expectStatus(401, 'POST', '/auth/refresh', { headers: { cookie: 'x=1' } });
    await expectStatus(204, 'POST', '/auth/logout', { headers: { cookie: `at_refresh=${next}` } });
    await expectStatus(204, 'POST', '/auth/logout');
  });

  it('refresh through the mock browser cookie jar', async () => {
    await expectStatus(200, 'POST', '/auth/login', { body: { email: 'lavka.head@agrotrace.test', password: DEMO_PASSWORD } });
    const r = await expectStatus(200, 'POST', '/auth/refresh');
    expect(r.body.expiresIn).toBe(900);
  });

  it('TOTP: inspector.head enables it (seed parity: nobody has it), then logs in with a challenge', async () => {
    const plain = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'inspector.head@agrotrace.test', password: DEMO_PASSWORD } });
    expect(plain.body.twoFactorRequired).toBe(false);
    const head = plain.body.accessToken as string;
    const setup = await expectStatus(200, 'POST', '/auth/2fa/setup', { token: head, body: {} });
    expect(setup.headers.get('Cache-Control')).toBe('no-store');
    await expectStatus(200, 'POST', '/auth/2fa/setup', { token: head, body: { code: mock.api.totp('inspector.head@agrotrace.test') } });

    const challenge = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'inspector.head@agrotrace.test', password: DEMO_PASSWORD } });
    expect(challenge.body.twoFactorRequired).toBe(true);
    const headCode = mock.api.totp('inspector.head@agrotrace.test');
    const wrong = (d: number) => String((Number(headCode) + d) % 1_000_000).padStart(6, '0');
    const bad1 = await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: challenge.body.challengeId, code: wrong(250_000) } });
    expect(bad1.body).toMatchObject({ code: 'INVALID_TWO_FACTOR_CODE', params: { attemptsLeft: 4 } });
    const bad2 = await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: challenge.body.challengeId, code: wrong(500_000) } });
    expect(bad2.body.params.attemptsLeft).toBe(3);
    const reused = await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: challenge.body.challengeId, code: headCode } });
    expect(reused.body).toMatchObject({ code: 'INVALID_TWO_FACTOR_CODE', params: { attemptsLeft: 2 } });
    mock.advance(31_000);
    const ok = await expectStatus(200, 'POST', '/auth/2fa/verify', { body: { challengeId: challenge.body.challengeId, code: mock.api.totp('inspector.head@agrotrace.test') } });
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: challenge.body.challengeId, code: '123456' } });
    await expectStatus(400, 'POST', '/auth/2fa/verify', { body: { challengeId: 'x', code: '1' } });
    const c2 = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'inspector.head@agrotrace.test', password: DEMO_PASSWORD } });
    for (let i = 1; i <= 5; i++) {
      const r = await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: c2.body.challengeId, code: wrong(100_000 * i) } });
      expect(r.body.params.attemptsLeft).toBe(5 - i);
    }
    const gone = await expectStatus(401, 'POST', '/auth/2fa/verify', { body: { challengeId: c2.body.challengeId, code: mock.api.totp('inspector.head@agrotrace.test') } });
    expect(gone.body.code).toBe('TOKEN_EXPIRED');
    tokens.delete('inspector.head@agrotrace.test');

    const t = await as('inspector');
    const start = await expectStatus(200, 'POST', '/auth/2fa/setup', { token: t, body: {} });
    expect(start.body.totpEnabled).toBe(false);
    const current = mock.api.totp('inspector@agrotrace.test');
    const wrongCode = String((Number(current) + 500_000) % 1_000_000).padStart(6, '0');
    await expectStatus(400, 'POST', '/auth/2fa/setup', { token: t, body: { code: wrongCode } });
    mock.advance(31_000);
    const enabled = await expectStatus(200, 'POST', '/auth/2fa/setup', { token: t, body: { code: mock.api.totp('inspector@agrotrace.test') } });
    expect(enabled.body.totpEnabled).toBe(true);
    await expectStatus(409, 'POST', '/auth/2fa/setup', { token: t, body: {} });
    await expectStatus(403, 'POST', '/auth/2fa/setup', { token: await as('petrov'), body: {} });
  });

  it('password reset and registration, invitation', async () => {
    await expectStatus(204, 'POST', '/auth/password/forgot', { body: { email: 'molkombinat.technolog@agrotrace.test' } });
    await expectStatus(204, 'POST', '/auth/password/forgot', { body: { email: 'nobody@agrotrace.test' } });
    const mail = mock.api.mailbox.find((m) => m.kind === 'passwordReset')!;
    expect(mail.link).toContain('/password/reset/');
    await expectStatus(400, 'POST', '/auth/password/reset', { body: { token: mail.token, password: 'short' } });
    await expectStatus(204, 'POST', '/auth/password/reset', { body: { token: mail.token, password: 'New-password-1' } });
    const again = await expectStatus(400, 'POST', '/auth/password/reset', { body: { token: mail.token, password: 'New-password-2' } });
    expect(again.body.code).toBe('TOKEN_EXPIRED');
    await expectStatus(200, 'POST', '/auth/login', { body: { email: 'molkombinat.technolog@agrotrace.test', password: 'New-password-1' } });

    const reg = await expectStatus(201, 'POST', '/auth/register-organization', {
      body: { inn: '7707083893', type: 'RETAILER', name: 'ООО «Новый магазин»', regionCode: '33', admin: { email: 'new.shop@agrotrace.test', fullName: 'Новиков Иван', password: 'Password-2026' } },
    });
    expect(reg.body.status).toBe('PENDING');
    const dup = await expectStatus(400, 'POST', '/auth/register-organization', {
      body: { inn: '7707083893', type: 'RETAILER', regionCode: '99', admin: { email: 'new.shop@agrotrace.test', fullName: 'X', password: 'Password-2026' } },
    });
    expect(dup.body.errors).toEqual({ inn: ['validation.inn.taken'], regionCode: ['validation.notFound'], 'admin.email': ['validation.email.taken'] });
    const pending = await expectStatus(403, 'POST', '/auth/login', { body: { email: 'new.shop@agrotrace.test', password: 'Password-2026' } });
    expect(pending.body.params.reason).toBe('ORGANIZATION_NOT_ACTIVE');

    const head = await as('petrov');
    const invited = await expectStatus(201, 'POST', '/users', { token: head, body: { email: 'Helper@agrotrace.test', fullName: 'Помощник', roles: ['FARMER'], isOrgAdmin: false } });
    expect(invited.body.status).toBe('INVITED');
    expect(invited.body.email).toBe('helper@agrotrace.test');
    const invite = mock.api.mailbox.find((m) => m.kind === 'invite')!;
    const invitedLogin = await expectStatus(401, 'POST', '/auth/login', { body: { email: 'helper@agrotrace.test', password: 'Password-2026' } });
    expect(invitedLogin.body.code).toBe('INVALID_CREDENTIALS');
    await expectStatus(204, 'POST', '/auth/accept-invite', { body: { token: invite.token, fullName: 'Помощник Петрова', password: 'Password-2026' } });
    await expectStatus(400, 'POST', '/auth/accept-invite', { body: { token: invite.token, fullName: 'X', password: 'Password-2026' } });
    await expectStatus(200, 'POST', '/auth/login', { body: { email: 'helper@agrotrace.test', password: 'Password-2026' } });
  });
});

describe('profile, users, organizations, files', () => {
  it('profile and channels', async () => {
    const t = await as('petrov');
    const me = await expectStatus(200, 'GET', '/me', { token: t });
    expect(me.body.avatarUrl).toMatch(/^\/api\/v1\/files\//);
    const upd = await expectStatus(200, 'PATCH', '/me', { token: t, body: { phone: null } });
    expect(upd.body.phone).toBeNull();
    const bad = await expectStatus(400, 'PATCH', '/me', { token: t, body: { fullName: '   ', extra: 1 } });
    expect(Object.keys(bad.body.errors).sort()).toEqual(['extra', 'fullName']);
    await expectStatus(400, 'PATCH', '/me', { token: t, body: {} });
    await expectStatus(200, 'GET', '/me/channels', { token: t });
    const notLinked = await expectStatus(400, 'PUT', '/me/channels', { token: t, body: { email: true, telegram: true } });
    expect(notLinked.body.errors.telegram).toEqual(['validation.telegram.notLinked']);
    const tg = await expectStatus(201, 'POST', '/me/telegram-code', { token: t });
    expect(await mock.api.linkTelegram(tg.body.code)).toBe(true);
    const linked = await expectStatus(200, 'PUT', '/me/channels', { token: t, body: { email: false, telegram: true } });
    expect(linked.body).toEqual({ email: false, telegram: true, telegramLinked: true });

    const up = await expectStatus(200, 'PUT', '/me/avatar', { token: t, form: form(webp, 'me.webp') });
    expect(up.body.mime).toBe('image/webp');
    const avatar = await expectStatus(200, 'GET', up.body.url.replace('/api/v1', ''));
    expect(avatar.headers.get('Content-Type')).toBe('image/webp');
    const etag = avatar.headers.get('ETag')!;
    await expectStatus(304, 'GET', up.body.url.replace('/api/v1', ''), { headers: { 'If-None-Match': etag } });
    await expectStatus(415, 'PUT', '/me/avatar', { token: t, form: form(pdf, 'x.pdf') });
    await expectStatus(413, 'PUT', '/me/avatar', { token: t, form: form(new Uint8Array(2 * 1024 * 1024 + 1), 'big.webp') });
    await expectStatus(400, 'PUT', '/me/avatar', { token: t, form: new FormData() });
    await expectStatus(204, 'DELETE', '/me/avatar', { token: t });
    await expectStatus(204, 'DELETE', '/me/avatar', { token: t });
    await expectStatus(404, 'GET', up.body.url.replace('/api/v1', ''));
  });

  it('users', async () => {
    const head = await as('zarya.head');
    const list = await expectStatus(200, 'GET', '/users?sort=email,asc', { token: head });
    expect(list.body.items.every((u: { organization: { name: string } }) => u.organization.name.includes('Заря'))).toBe(true);
    await expectStatus(400, 'GET', `/users?organizationId=${UNKNOWN}`, { token: head });
    await expectStatus(403, 'GET', '/users', { token: await as('zarya.agronom') });
    const admin = await as('admin');
    const all = await expectStatus(200, 'GET', '/users?size=100&role=INSPECTOR', { token: admin });
    expect(all.body.total).toBe(2);
    const agronom = mock.api.store.t.users.find((u) => u.email === 'zarya.agronom@agrotrace.test')!;
    const blocked = await expectStatus(200, 'PATCH', `/users/${agronom.id}`, { token: head, body: { status: 'BLOCKED' } });
    expect(blocked.body.status).toBe('BLOCKED');
    const refused = await expectStatus(403, 'POST', '/auth/login', { body: { email: agronom.email, password: DEMO_PASSWORD } });
    expect(refused.body.params.reason).toBe('USER_BLOCKED');
    await expectStatus(200, 'PATCH', `/users/${agronom.id}`, { token: head, body: { status: 'ACTIVE' } });
    await expectStatus(400, 'PATCH', `/users/${agronom.id}`, { token: head, body: { roles: ['LAB'] } });
    await expectStatus(404, 'PATCH', `/users/${agronom.id}`, { token: await as('petrov'), body: { status: 'BLOCKED' } });
    const self = mock.api.store.t.users.find((u) => u.email === 'zarya.head@agrotrace.test')!;
    await expectStatus(400, 'PATCH', `/users/${self.id}`, { token: head, body: { isOrgAdmin: false } });
    const invited = mock.api.store.t.users.find((u) => u.status === 'INVITED');
    if (invited) {
      const orgHead = mock.api.store.t.users.find((u) => u.organization_id === invited.organization_id && u.is_org_admin)!;
      await expectStatus(409, 'PATCH', `/users/${invited.id}`, { token: await as(orgHead.email), body: { status: 'BLOCKED' } });
    }
    const petrov = mock.api.store.t.users.find((u) => u.email === 'provizia.head@agrotrace.test')!;
    await expectStatus(200, 'GET', `/users/${petrov.id}/avatar?variant=96`, { token: head });
    await expectStatus(404, 'GET', `/users/${agronom.id}/avatar`, { token: head });
    await expectStatus(400, 'GET', `/users/${agronom.id}/avatar?variant=12`, { token: head });
  });

  it('organizations and logos', async () => {
    const t = await as('lavka.head');
    const dir = await expectStatus(200, 'GET', '/organizations?type=FARM&type=PROCESSOR', { token: t });
    expect(dir.body.items.every((o: { type: string }) => ['FARM', 'PROCESSOR'].includes(o.type))).toBe(true);
    await expectStatus(200, 'GET', `/organizations?q=${encodeURIComponent('ооо «м')}`, { token: t });
    await expectStatus(400, 'GET', '/organizations?type=X', { token: t });
    const own = org('Фермерская лавка');
    await expectStatus(200, 'GET', `/organizations/${own.id}`, { token: t });
    await expectStatus(404, 'GET', `/organizations/${org('Мелькомбинат').id}`, { token: t });
    await expectStatus(200, 'GET', `/organizations/${org('Мелькомбинат').id}`, { token: await as('inspector') });
    const logo = await expectStatus(200, 'PUT', `/organizations/${own.id}/logo`, { token: t, form: form(svg, 'logo.svg') });
    expect(logo.body.url).toMatch(/^\/api\/v1\/public\/files\//);
    const img = await expectStatus(200, 'GET', `/organizations/${own.id}/logo`, { token: t });
    expect(img.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(img.text).toContain('style="fill: red"');
    expect(img.text).not.toContain('evil');
    const refused = await expectStatus(415, 'PUT', `/organizations/${own.id}/logo`, { token: t, form: form(svgScript, 'x.svg') });
    expect(refused.body.params).toEqual({ allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'] });
    expect(img.text).not.toContain('onclick');
    await expectStatus(404, 'PUT', `/organizations/${org('Провизия').id}/logo`, { token: t, form: form(svg, 'logo.svg') });
    await expectStatus(403, 'PUT', `/organizations/${org('Молкомбинат').id}/logo`, { token: t, form: form(svg, 'logo.svg') });
    await expectStatus(403, 'PUT', `/organizations/${own.id}/logo`, { token: await as('provizia.manager'), form: form(svg, 'logo.svg') });
    await expectStatus(404, 'GET', `/organizations/${UNKNOWN}/logo`, { token: t });
  });

  it('files: signed, bearer and public access', async () => {
    const t = await as('provizia.head');
    const me = await expectStatus(200, 'GET', '/me', { token: t });
    const url: string = me.body.avatarUrl.replace('/api/v1', '');
    const signed = await expectStatus(200, 'GET', url);
    expect(signed.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(signed.headers.get('Content-Disposition')).toMatch(/^inline; filename="avatar-4\.webp"; filename\*=UTF-8''avatar-4\.webp$/);
    await expectStatus(200, 'GET', `${url}&variant=96`);
    await expectStatus(403, 'GET', url.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`));
    await expectStatus(403, 'GET', url.replace(/&sig=[0-9a-f]+/, ''));
    const id = url.split('?')[0]!.split('/').pop()!;
    await expectStatus(401, 'GET', `/files/${id}`);
    await expectStatus(200, 'GET', `/files/${id}`, { token: t });
    await expectStatus(400, 'GET', '/files/not-a-uuid', { token: t });
    const products = await expectStatus(200, 'GET', '/dictionaries/products?size=1', { token: t });
    const pub = await expectStatus(200, 'GET', products.body.items[0].imageUrl.replace('/api/v1', ''));
    expect(pub.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(pub.bytes.length).toBeGreaterThan(1000);
    await expectStatus(404, 'GET', `/public/files/${id}`);
    const protocolTest = mock.api.store.t.lab_tests.find((x) => x.protocol_file_id && x.batch_id === batchId(2 - 1))!;
    await expectStatus(404, 'GET', `/files/${protocolTest.protocol_file_id}`, { token: await as('zarya.head') });
  });
});

describe('fields and treatments', () => {
  it('CRUD, visibility, the edit window', async () => {
    const t = await as('petrov');
    const list = await expectStatus(200, 'GET', '/fields?sort=areaHa,desc', { token: t });
    expect(list.body.total).toBe(2);
    await expectStatus(400, 'GET', `/fields?organizationId=${UNKNOWN}`, { token: t });
    const all = await expectStatus(200, 'GET', `/fields?organizationId=${org('Заря').id}`, { token: await as('inspector') });
    expect(all.body.total).toBe(2);
    const ring = [[39, 56], [39.01, 56], [39.01, 56.01], [39, 56]];
    const created = await expectStatus(201, 'POST', '/fields', { token: t, body: { name: 'Новое поле', areaHa: '12.50', regionCode: '33', geometry: { type: 'Polygon', coordinates: [ring] } } });
    const open = await expectStatus(400, 'POST', '/fields', { token: t, body: { name: 'X', areaHa: '1.00', regionCode: '33', geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 2], [3, 3], [4, 4]]] } } });
    expect(open.body.errors.geometry).toContain('validation.geometry.ringNotClosed');
    const region = await expectStatus(400, 'POST', '/fields', { token: t, body: { name: 'X', areaHa: '1.00', regionCode: '99' } });
    expect(region.body.errors).toEqual({ regionCode: ['validation.notFound'] });
    await expectStatus(200, 'GET', `/fields/${created.body.id}`, { token: t });
    await expectStatus(404, 'GET', `/fields/${created.body.id}`, { token: await as('zarya.head') });
    await expectStatus(200, 'PUT', `/fields/${created.body.id}`, { token: t, body: { name: 'Новое поле 2', areaHa: '13.00', regionCode: '50' } });
    const subs = await expectStatus(200, 'GET', '/dictionaries/substances', { token: t });
    const sub = subs.body.items[0];
    const treat = await expectStatus(201, 'POST', `/fields/${created.body.id}/treatments`, {
      token: t,
      body: { substanceId: sub.id, dose: '1.500', doseUnit: 'л/га', appliedAt: new Date(mock.now() - 3600_000).toISOString() },
    });
    const future = await expectStatus(400, 'POST', `/fields/${created.body.id}/treatments`, {
      token: t,
      body: { substanceId: UNKNOWN, dose: '1.500', doseUnit: 'л/га', appliedAt: new Date(mock.now() + 86400_000).toISOString() },
    });
    expect(future.body.errors).toEqual({ substanceId: ['validation.notFound'], appliedAt: ['validation.date.future'] });
    const page = await expectStatus(200, 'GET', `/fields/${created.body.id}/treatments?from=2020-01-01`, { token: t });
    expect(page.body.total).toBe(1);
    await expectStatus(400, 'GET', `/fields/${created.body.id}/treatments?from=2026-02-30`, { token: t });
    await expectStatus(200, 'PUT', `/treatments/${treat.body.id}`, { token: t, body: { substanceId: sub.id, dose: '2.000', doseUnit: 'л/га', appliedAt: treat.body.appliedAt } });
    mock.advance(25 * 3600_000);
    const closed = await expectStatus(403, 'PUT', `/treatments/${treat.body.id}`, { token: await as('petrov'), body: { substanceId: sub.id, dose: '2.000', doseUnit: 'л/га', appliedAt: treat.body.appliedAt } });
    expect(closed.body.params.reason).toBe('EDIT_WINDOW_CLOSED');
    const t2 = await as('petrov');
    await expectStatus(204, 'DELETE', `/fields/${created.body.id}`, { token: t2 });
    await expectStatus(404, 'DELETE', `/fields/${created.body.id}`, { token: t2 });
    await expectStatus(403, 'POST', '/fields', { token: await as('inspector'), body: {} });
  });
});

describe('batches, waybills, processing', () => {
  it('lists, cards, graph, history, path, documents', async () => {
    const t = await as('molkombinat.head');
    const list = await expectStatus(200, 'GET', '/batches?holder=me&status=Processed&sort=publicCode,asc', { token: t });
    expect(list.body.items.every((b: { status: string }) => b.status === 'Processed')).toBe(true);
    await expectStatus(400, 'GET', `/batches?orgId=${UNKNOWN}`, { token: t });
    await expectStatus(200, 'GET', `/batches?orgId=${org('Луговая').id}&kind=RAW&from=2026-01-01`, { token: await as('inspector') });
    const b = await expectStatus(200, 'GET', `/batches/${batchId(6)}`, { token: t });
    expect(b.body.publicCode).toBe(code(6));
    await expectStatus(404, 'GET', `/batches/${batchId(26)}`, { token: t });
    const graph = await expectStatus(200, 'GET', `/batches/${batchId(6)}/graph?depth=5`, { token: t });
    expect(graph.body.nodes.map((n: { depth: number }) => n.depth)).toEqual([...graph.body.nodes.map((n: { depth: number }) => n.depth)].sort((x, y) => x - y));
    expect(graph.body.nodes.some((n: { depth: number }) => n.depth < 0)).toBe(true);
    await expectStatus(400, 'GET', `/batches/${batchId(6)}/graph?depth=9`, { token: t });
    await expectStatus(200, 'GET', `/batches/${batchId(6)}/history`, { token: t });
    const path = await expectStatus(200, 'GET', `/batches/${batchId(2)}/path`, { token: await as('provizia.head') });
    expect(path.body.at(-1).to).toBeNull();
    const docs = await expectStatus(200, 'GET', `/batches/${batchId(10)}/documents`, { token: await as('inspector') });
    expect(docs.body.vsd.importStatus).toBe('IMPORTED');
    expect(docs.body.labProtocols.length).toBeGreaterThan(0);
    await expectStatus(404, 'GET', `/batches/${batchId(10)}/documents`, { token: await as('vetlab.head') });
    const labDocs = await expectStatus(200, 'GET', `/batches/${batchId(10)}/documents`, { token: await as('agrotest.head') });
    expect(labDocs.body.qr).toBeNull();
  });

  it('batch registration: risk model, lab assignment, VSD, references', async () => {
    const t = await as('lugovaya.zootech');
    const fields = await expectStatus(200, 'GET', '/fields', { token: t });
    const milk = mock.api.store.t.products.find((p) => p.name === 'Молоко сырое коровье')!;
    const wheat = mock.api.store.t.products.find((p) => p.name === 'Пшеница мягкая')!;
    const flour = mock.api.store.t.products.find((p) => p.category === 'PROCESSED')!;
    const at = new Date(mock.now() - 7200_000).toISOString();
    const b = await expectStatus(201, 'POST', '/batches', { token: t, body: { fieldId: fields.body.items[0].id, productId: milk.id, massKg: '3100.000', harvestedAt: at } });
    expect(b.body).toMatchObject({ kind: 'RAW', status: 'OnTest', testRequired: true, version: 2 });
    expect(b.body.publicCode).toBe(code(mock.api.store.t.batches.length));
    const docs = await expectStatus(200, 'GET', `/batches/${b.body.id}/documents`, { token: t });
    expect(['IMPORTED', 'NOT_FOUND']).toContain(docs.body.vsd.importStatus);
    const refs = await expectStatus(400, 'POST', '/batches', {
      token: t,
      body: { fieldId: UNKNOWN, productId: flour.id, massKg: '1.000', harvestedAt: new Date(mock.now() + 86_400_000).toISOString() },
    });
    expect(refs.body.errors).toEqual({ fieldId: ['validation.notFound'], productId: ['validation.product.category'], harvestedAt: ['validation.date.future'] });
    const zero = await expectStatus(400, 'POST', '/batches', { token: t, body: { fieldId: fields.body.items[0].id, productId: wheat.id, massKg: '0.000', harvestedAt: at } });
    expect(zero.body.errors).toEqual({ massKg: ['validation.positive'] });
    await expectStatus(403, 'POST', '/batches', { token: await as('molkombinat.head'), body: {} });
  });

  it('VSD retry', async () => {
    const t = await as('lugovaya.zootech');
    const r = await expectStatus(202, 'POST', `/batches/${batchId(40)}/documents/vsd/retry`, { token: t, headers: { 'Idempotency-Key': 'vsd-retry-0001' } });
    expect(r.body.importStatus).toBe('PENDING');
    await expectStatus(400, 'POST', `/batches/${batchId(40)}/documents/vsd/retry`, { token: t });
    const conflict = await expectStatus(409, 'POST', `/batches/${batchId(40)}/documents/vsd/retry`, { token: t, headers: { 'Idempotency-Key': 'vsd-retry-0001' }, body: {} });
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const docs = await expectStatus(200, 'GET', `/batches/${batchId(40)}/documents`, { token: t });
    expect(['IMPORTED', 'NOT_FOUND']).toContain(docs.body.vsd.importStatus);
    await expectStatus(404, 'POST', `/batches/${batchId(31)}/documents/vsd/retry`, { token: await as('zarya.head'), headers: { 'Idempotency-Key': 'vsd-retry-0002' } });
  });

  it('waybill: create → send → accept (BR-07) → QR → on sale → sold', async () => {
    const mel = await as('melkombinat.head');
    const qr = await expectStatus(201, 'POST', `/batches/${batchId(21)}/qr`, { token: mel });
    expect(qr.body.publicUrl).toBe(`http://localhost/p/${code(21)}`);
    const png = await expectStatus(200, 'GET', `/batches/${batchId(21)}/qr?format=png`, { token: mel });
    expect(png.headers.get('Content-Type')).toBe('image/png');
    expect(Array.from(png.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const lpdf = await expectStatus(200, 'GET', `/batches/${batchId(21)}/qr?format=pdf`, { token: mel });
    expect(lpdf.text.startsWith('%PDF-')).toBe(true);
    await expectStatus(400, 'GET', `/batches/${batchId(21)}/qr`, { token: mel });
    await expectStatus(404, 'POST', `/batches/${batchId(23)}/qr`, { token: await as('provizia.head') });
    const qrStatus = await expectStatus(403, 'POST', `/batches/${batchId(6)}/qr`, { token: await as('molkombinat.head') });
    expect(qrStatus.body.params).toEqual({ reason: 'BATCH_STATUS', status: 'Processed' });

    const provizia = org('Провизия').id;
    const created = await expectStatus(201, 'POST', '/waybills', {
      token: mel,
      headers: { 'Idempotency-Key': 'wb-flow-00000001' },
      body: { receiverOrgId: provizia, items: [{ batchId: batchId(21), massDeclaredKg: '900.000' }] },
    });
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.actions).toEqual(['send', 'delete']);
    const replay = await expectStatus(201, 'POST', '/waybills', {
      token: mel,
      headers: { 'Idempotency-Key': 'wb-flow-00000001' },
      body: { receiverOrgId: provizia, items: [{ batchId: batchId(21), massDeclaredKg: '900.000' }] },
    });
    expect(replay.body.id).toBe(created.body.id);
    const badKey = await expectStatus(400, 'POST', '/waybills', { token: mel, headers: { 'Idempotency-Key': 'x' }, body: {} });
    expect(badKey.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    const refs = await expectStatus(400, 'POST', '/waybills', {
      token: mel,
      headers: { 'Idempotency-Key': 'wb-flow-00000002' },
      body: { receiverOrgId: org('Заря').id, items: [{ batchId: batchId(21), massDeclaredKg: '9000.000' }, { batchId: UNKNOWN, massDeclaredKg: '1.000' }] },
    });
    expect(refs.body.errors).toEqual({ receiverOrgId: ['validation.receiver.type'], 'items[0].massDeclaredKg': ['validation.mass.exceedsBatch'], 'items[1].batchId': ['validation.notFound'] });
    const dupe = await expectStatus(400, 'POST', '/waybills', {
      token: mel,
      headers: { 'Idempotency-Key': 'wb-flow-00000004' },
      body: { receiverOrgId: provizia, items: [{ batchId: batchId(21), massDeclaredKg: '1.000' }, { batchId: batchId(21), massDeclaredKg: '1.000' }] },
    });
    expect(dupe.body.errors).toEqual({ 'items[1].batchId': ['validation.duplicate'] });
    const wire = await expectStatus(400, 'POST', '/waybills', {
      token: mel,
      headers: { 'Idempotency-Key': 'wb-flow-00000003' },
      body: { receiverOrgId: provizia, items: [{ batchId: batchId(21), massDeclaredKg: '900' }] },
    });
    expect(wire.body.errors).toEqual({ 'items[0].massDeclaredKg': ['validation.mass.format'] });

    const stale = await expectStatus(409, 'POST', `/waybills/${created.body.id}/send`, { token: mel, headers: { 'If-Match': '7', 'Idempotency-Key': 'wb-send-00000001' } });
    expect(stale.body.params.currentVersion).toBe(1);
    await expectStatus(400, 'POST', `/waybills/${created.body.id}/send`, { token: mel, headers: { 'Idempotency-Key': 'wb-send-00000002' } });
    const sent = await expectStatus(200, 'POST', `/waybills/${created.body.id}/send`, { token: mel, headers: { 'If-Match': '1', 'Idempotency-Key': 'wb-send-00000003' } });
    expect(sent.body.status).toBe('SENT');
    expect(sent.body.items[0].batch.status).toBe('InTransit');
    const prov = await as('provizia.head');
    const incoming = await expectStatus(200, 'GET', '/waybills?direction=incoming&status=SENT', { token: prov });
    expect(incoming.body.items.map((w: { id: string }) => w.id)).toContain(created.body.id);
    await expectStatus(400, 'GET', '/waybills?direction=incoming', { token: await as('inspector') });
    await expectStatus(404, 'POST', `/waybills/${created.body.id}/accept`, { token: await as('lavka.head'), headers: { 'If-Match': '2', 'Idempotency-Key': 'wb-acc-00000000' }, body: { items: [{ batchId: batchId(21), massActualKg: '900.000' }] } });
    await expectStatus(403, 'POST', `/waybills/${created.body.id}/accept`, { token: mel, headers: { 'If-Match': '2', 'Idempotency-Key': 'wb-acc-00000009' }, body: { items: [{ batchId: batchId(21), massActualKg: '900.000' }] } });
    const br07 = await expectStatus(422, 'POST', `/waybills/${created.body.id}/accept`, {
      token: prov,
      headers: { 'If-Match': '2', 'Idempotency-Key': 'wb-acc-00000001' },
      body: { items: [{ batchId: batchId(21), massActualKg: '850.000' }] },
    });
    expect(br07.body).toMatchObject({ rule: 'BR-07', params: { publicCode: code(21), percent: '5.56' } });
    const mismatch = await expectStatus(400, 'POST', `/waybills/${created.body.id}/accept`, {
      token: prov,
      headers: { 'If-Match': '2', 'Idempotency-Key': 'wb-acc-00000002' },
      body: { items: [{ batchId: batchId(20), massActualKg: '850.000' }] },
    });
    expect(mismatch.body.errors).toEqual({ items: ['validation.items.mismatch'] });
    const accepted = await expectStatus(200, 'POST', `/waybills/${created.body.id}/accept`, {
      token: prov,
      headers: { 'If-Match': '2', 'Idempotency-Key': 'wb-acc-00000003' },
      body: { items: [{ batchId: batchId(21), massActualKg: '850.000', discrepancyAct: 'Недостача 50 кг' }] },
    });
    expect(accepted.body.items[0]).toMatchObject({ massActualKg: '850.000', discrepancyPercent: '5.56' });
    await expectStatus(200, 'GET', `/waybills/${created.body.id}`, { token: prov });

    const card = await expectStatus(200, 'GET', `/batches/${batchId(21)}`, { token: prov });
    expect(card.body.holder.id).toBe(provizia);
    expect(card.body.actions.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['putOnSale']));
    await expectStatus(409, 'POST', `/batches/${batchId(21)}/sold`, { token: prov, headers: { 'If-Match': String(card.body.version) } });
    const onSale = await expectStatus(200, 'POST', `/batches/${batchId(21)}/on-sale`, { token: prov, headers: { 'If-Match': String(card.body.version) } });
    const vc = await expectStatus(409, 'POST', `/batches/${batchId(21)}/sold`, { token: prov, headers: { 'If-Match': String(card.body.version) } });
    expect(vc.body.code).toBe('VERSION_CONFLICT');
    await expectStatus(200, 'POST', `/batches/${batchId(21)}/sold`, { token: prov, headers: { 'If-Match': String(onSale.body.version) } });
    const notHolder = await expectStatus(403, 'POST', `/batches/${batchId(1)}/sold`, { token: prov, headers: { 'If-Match': '1' } });
    expect(notHolder.body.params).toEqual({ reason: 'NOT_HOLDER' });
  });

  it('waybill: BR-06 on accept, reject reassigns the recall task (R50), draft delete', async () => {
    const koltso = await as('koltso.head');
    const wb = waybillId(27);
    const card = await expectStatus(200, 'GET', `/waybills/${wb}`, { token: koltso });
    const items = card.body.items.map((i: { batch: { id: string }; massDeclaredKg: string }) => ({ batchId: i.batch.id, massActualKg: i.massDeclaredKg }));
    const br06 = await expectStatus(422, 'POST', `/waybills/${wb}/accept`, { token: koltso, headers: { 'If-Match': String(card.body.version), 'Idempotency-Key': 'wb27-accept-0001' }, body: { items } });
    expect(br06.body.rule).toBe('BR-06');
    const rejected = await expectStatus(200, 'POST', `/waybills/${wb}/reject`, { token: koltso, headers: { 'If-Match': String(card.body.version) }, body: { reason: 'Партия отозвана' } });
    expect(rejected.body.status).toBe('REJECTED');
    await expectStatus(409, 'POST', `/waybills/${wb}/reject`, { token: koltso, headers: { 'If-Match': String(rejected.body.version) }, body: { reason: 'x' } });
    const tasks = await expectStatus(200, 'GET', `/recall-tasks?q=${card.body.items[0].batch.publicCode}`, { token: await as('molkombinat.head') });
    expect(tasks.body.total).toBe(1);

    const zarya = await as('zarya.head');
    const draft = waybillId(26);
    await expectStatus(409, 'DELETE', `/waybills/${draft}`, { token: zarya, headers: { 'If-Match': '5' } });
    await expectStatus(404, 'DELETE', `/waybills/${draft}`, { token: await as('melkombinat.head'), headers: { 'If-Match': '1' } });
    await expectStatus(204, 'DELETE', `/waybills/${draft}`, { token: zarya, headers: { 'If-Match': '1' } });
    await expectStatus(404, 'GET', `/waybills/${draft}`, { token: zarya });
    const sentDelete = await expectStatus(409, 'DELETE', `/waybills/${waybillId(28)}`, { token: zarya, headers: { 'If-Match': '2' } });
    expect(sentDelete.body.params).toEqual({ from: 'SENT', to: 'DELETED' });
  });

  it('processing: BR-05, BR-04, success', async () => {
    const mel = await as('melkombinat.head');
    const flour = mock.api.store.t.products.find((p) => p.name.startsWith('Мука'))!;
    const wheat = batchId(23);
    const br04 = await expectStatus(422, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: wheat, massUsedKg: '1000.000' }], outputs: [{ productId: flour.id, massKg: '999.000' }] } });
    expect(br04.body.rule).toBe('BR-04');
    const br05 = await expectStatus(422, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: batchId(18), massUsedKg: '1.000' }], outputs: [{ productId: flour.id, massKg: '0.500' }] } });
    expect(br05.body.rule).toBe('BR-05');
    const refs = await expectStatus(400, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: UNKNOWN, massUsedKg: '1.000' }], outputs: [{ productId: UNKNOWN, massKg: '1.000' }] } });
    expect(refs.body.errors).toEqual({ 'inputs[0].batchId': ['validation.notFound'], 'outputs[0].productId': ['validation.notFound'] });
    const ok = await expectStatus(201, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: wheat, massUsedKg: '10000.000' }], outputs: [{ productId: flour.id, massKg: '7000.000' }, { productId: flour.id, massKg: '500.000' }] } });
    expect(ok.body.outputs).toHaveLength(2);
    expect(ok.body.outputs[0].version).toBe(2);
    expect(ok.body.balance.inputKg).toBe('10000.000');
    await expectStatus(403, 'POST', '/processing', { token: await as('petrov'), body: {} });
  });
});

describe('lab, recalls, complaints', () => {
  it('lab test lifecycle and inspector assignment', async () => {
    const lab = await as('agrotest.head');
    const queue = await expectStatus(200, 'GET', '/lab-tests?status=QUEUED&status=SAMPLED', { token: lab });
    const test = queue.body.items.find((x: { batch: { publicCode: string } }) => x.batch.publicCode === code(40));
    expect(test).toBeDefined();
    await expectStatus(400, 'GET', `/lab-tests?labOrgId=${UNKNOWN}`, { token: lab });
    const sampled = await expectStatus(200, 'POST', `/lab-tests/${test.id}/sample`, { token: lab, headers: { 'If-Match': '1' } });
    await expectStatus(409, 'POST', `/lab-tests/${test.id}/sample`, { token: lab, headers: { 'If-Match': String(sampled.body.version) } });
    const mismatch = await expectStatus(400, 'POST', `/lab-tests/${test.id}/results`, { token: lab, headers: { 'If-Match': String(sampled.body.version) }, body: { results: [{ indicatorId: UNKNOWN, value: '1' }] } });
    expect(mismatch.body.errors).toEqual({ results: ['validation.results.mismatch'] });
    const results = sampled.body.norms.map((n: { indicatorId: string }) => ({ indicatorId: n.indicatorId, value: '0.000001' }));
    const done = await expectStatus(200, 'POST', `/lab-tests/${test.id}/results`, { token: lab, headers: { 'If-Match': String(sampled.body.version) }, body: { results } });
    expect(done.body).toMatchObject({ status: 'DONE', conclusion: 'PASS', recallId: null });
    const up = await expectStatus(200, 'PUT', `/lab-tests/${test.id}/protocol`, { token: lab, form: form(pdf, 'protocol.pdf') });
    expect(up.body.mime).toBe('application/pdf');
    await expectStatus(415, 'PUT', `/lab-tests/${test.id}/protocol`, { token: lab, form: form(webp, 'x.webp') });
    const dl = await expectStatus(200, 'GET', `/lab-tests/${test.id}/protocol`, { token: await as('lugovaya.head') });
    expect(dl.text.startsWith('%PDF-')).toBe(true);
    await expectStatus(404, 'GET', `/lab-tests/${test.id}`, { token: await as('vetlab.head') });

    const insp = await as('inspector');
    const bad = await expectStatus(400, 'POST', '/lab-tests', { token: insp, body: { batchId: batchId(20), labOrgId: org('Мелькомбинат').id } });
    expect(bad.body.errors).toEqual({ labOrgId: ['validation.labOrg.type'] });
    const created = await expectStatus(201, 'POST', '/lab-tests', { token: insp, body: { batchId: batchId(20), labOrgId: org('Клязьма').id } });
    expect(created.body).toMatchObject({ reason: 'INSPECTOR', status: 'QUEUED' });
    await expectStatus(200, 'GET', `/lab-tests/${created.body.id}`, { token: insp });
    await expectStatus(403, 'POST', '/lab-tests', { token: lab, body: {} });
    const seeded = mock.api.store.t.lab_tests.find((x) => x.protocol_file_id && x.batch_id === batchId(10) && x.reason === 'INSPECTOR')!;
    const seededPdf = await expectStatus(200, 'GET', `/lab-tests/${seeded.id}/protocol`, { token: insp });
    expect(seededPdf.text.startsWith('%PDF-')).toBe(true);
  });

  it('recalls: manual (201, then 200 for the open one), graph, tasks, confirm', async () => {
    const insp = await as('inspector');
    const created = await expectStatus(201, 'POST', '/recalls', { token: insp, body: { sourceBatchId: batchId(31), reason: 'Проверка', blockUpstream: false } });
    expect(created.body.status).toBe('OPEN');
    expect(created.body.batches[0].direction).toBe('SOURCE');
    const again = await expectStatus(200, 'POST', '/recalls', { token: insp, body: { sourceBatchId: batchId(31), reason: 'Ещё раз', blockUpstream: true } });
    expect(again.body.id).toBe(created.body.id);
    await expectStatus(400, 'POST', '/recalls', { token: insp, body: { sourceBatchId: UNKNOWN, reason: 'x', blockUpstream: false } });
    const vacuous = await expectStatus(201, 'POST', '/recalls', { token: insp, body: { sourceBatchId: batchId(3), reason: 'Реализована', blockUpstream: false } });
    expect(vacuous.body).toMatchObject({ status: 'CLOSED', version: 2 });
    const list = await expectStatus(200, 'GET', '/recalls?status=OPEN&trigger=LAB&trigger=INSPECTOR', { token: insp });
    expect(list.body.total).toBeGreaterThanOrEqual(3);
    await expectStatus(200, 'GET', `/recalls?batchId=${batchId(6)}`, { token: await as('admin') });
    await expectStatus(403, 'GET', '/recalls', { token: await as('petrov') });
    const card = await expectStatus(200, 'GET', `/recalls/${list.body.items[0].id}`, { token: insp });
    expect(card.body.batches.length).toBe(card.body.batchesCount);
    const graph = await expectStatus(200, 'GET', `/recalls/${list.body.items[0].id}/graph`, { token: insp });
    expect(graph.body.nodes.length).toBeGreaterThan(0);
    await expectStatus(404, 'GET', `/recalls/${UNKNOWN}`, { token: insp });

    const zarya = await as('zarya.head');
    const tasks = await expectStatus(200, 'GET', '/recall-tasks?status=OPEN&status=OVERDUE', { token: zarya });
    expect(tasks.body.total).toBe(2);
    await expectStatus(400, 'GET', `/recall-tasks?holderOrgId=${UNKNOWN}`, { token: zarya });
    const task = tasks.body.items[0];
    const confirmed = await expectStatus(200, 'POST', `/recall-tasks/${task.id}/confirm`, { token: zarya, headers: { 'If-Match': String(task.version), 'Idempotency-Key': 'task-confirm-0001' }, body: {} });
    expect(confirmed.body.confirmedBy.fullName).toBeTruthy();
    const twice = await expectStatus(409, 'POST', `/recall-tasks/${task.id}/confirm`, { token: zarya, headers: { 'If-Match': String(confirmed.body.version), 'Idempotency-Key': 'task-confirm-0002' } });
    expect(twice.body.params).toEqual({ from: 'CONFIRMED', to: 'CONFIRMED' });
    await expectStatus(404, 'POST', `/recall-tasks/${tasks.body.items[1].id}/confirm`, { token: await as('petrov'), headers: { 'If-Match': '1', 'Idempotency-Key': 'task-confirm-0003' } });
    const insTasks = await expectStatus(200, 'GET', `/recall-tasks?holderOrgId=${org('Провизия').id}&overdue=false`, { token: insp });
    expect(insTasks.body.items.every((x: { holder: { name: string } }) => x.holder.name.includes('Провизия'))).toBe(true);
  });

  it('complaints: public creation (ALTCHA), review, the three decisions', async () => {
    const challenge = await expectStatus(200, 'GET', '/public/captcha');
    const altcha = solveChallenge(challenge.body);
    const pc = await expectStatus(201, 'POST', `/public/batches/${code(28)}/complaints`, { body: { text: 'Яблоки с гнилью внутри плодов.', altcha } });
    const reuse = await expectStatus(400, 'POST', `/public/batches/${code(28)}/complaints`, { body: { text: 'Яблоки с гнилью внутри плодов.', altcha } });
    expect(reuse.body.code).toBe('CAPTCHA_FAILED');
    await expectStatus(400, 'POST', `/public/batches/${code(28)}/complaints`, { body: { text: 'коротко', altcha: 'x' } });
    await expectStatus(404, 'POST', `/public/batches/AT-2026-999999/complaints`, { body: { text: 'Текст жалобы длинный.', altcha: solveChallenge((await expectStatus(200, 'GET', '/public/captcha')).body) } });
    await expectStatus(400, 'POST', `/public/batches/XX/complaints`, { body: {} });

    const insp = await as('inspector');
    const list = await expectStatus(200, 'GET', '/complaints?status=NEW&status=IN_REVIEW', { token: insp });
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(pc.body.id);
    const card = await expectStatus(200, 'GET', `/complaints/${pc.body.id}`, { token: insp });
    expect(card.body.contact).toBeNull();
    await expectStatus(200, 'POST', `/complaints/${pc.body.id}/review`, { token: insp });
    await expectStatus(409, 'POST', `/complaints/${pc.body.id}/review`, { token: insp });
    const notAllowed = await expectStatus(400, 'POST', `/complaints/${pc.body.id}/decision`, { token: insp, body: { decision: 'REJECT', comment: 'x', labOrgId: UNKNOWN } });
    expect(notAllowed.body.errors).toEqual({ labOrgId: ['validation.notAllowed'] });
    const recall = await expectStatus(200, 'POST', `/complaints/${pc.body.id}/decision`, { token: insp, body: { decision: 'RECALL', comment: 'Подтверждено' } });
    expect(recall.body.recallId).toBeTruthy();
    await expectStatus(409, 'POST', `/complaints/${pc.body.id}/decision`, { token: insp, body: { decision: 'REJECT', comment: 'x' } });
    const others = mock.api.store.t.complaints.filter((c) => c.status !== 'DECIDED' && c.id !== pc.body.id);
    const labDecision = await expectStatus(200, 'POST', `/complaints/${others[0]!.id}/decision`, { token: insp, body: { decision: 'LAB_TEST', comment: 'Анализ', labOrgId: org('Клязьма').id } });
    expect(labDecision.body.labTestId).toBeTruthy();
    await expectStatus(200, 'POST', `/complaints/${others[1]!.id}/decision`, { token: insp, body: { decision: 'REJECT', comment: 'Не подтверждено' } });
    await expectStatus(403, 'GET', '/complaints', { token: await as('admin') });
    await expectStatus(404, 'GET', `/complaints/${UNKNOWN}`, { token: insp });
  });
});

describe('notifications, analytics, reports', () => {
  it('notifications and marks', async () => {
    const t = await as('provizia.manager');
    const list = await expectStatus(200, 'GET', '/notifications?size=5', { token: t });
    expect(list.body.items[0].seq).toBeGreaterThan(list.body.items.at(-1).seq);
    const unread = await expectStatus(200, 'GET', '/notifications?isRead=false&type=RECALL_TASK', { token: t });
    void unread;
    const marked = await expectStatus(200, 'POST', '/notifications/read', { token: t, body: { upToSeq: list.body.items[0].seq } });
    expect(marked.body.count).toBe(0);
    const bad = await expectStatus(400, 'POST', '/notifications/read', { token: t, body: { ids: [UNKNOWN] } });
    expect(bad.body.errors).toEqual({ 'ids[0]': ['validation.notFound'] });
    await expectStatus(200, 'POST', '/notifications/read', { token: t, body: { ids: [list.body.items[0].id] } });
  });

  it('SSE stream: unread on connect, notification pushed, 401 with a bad token', async () => {
    const t = await as('inspector.head');
    const res = await mock.api.handle(new Request(`${BASE}/events/stream?access_token=${t}&lastEventId=1`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: unread')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: notification');
    const challenge = await expectStatus(200, 'GET', '/public/captcha');
    await expectStatus(201, 'POST', `/public/batches/${code(29)}/complaints`, { body: { text: 'Капуста с чёрными пятнами.', altcha: solveChallenge(challenge.body) } });
    let pushed = '';
    while (!pushed.includes('"type":"COMPLAINT"')) pushed += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    coverage.set('streamEvents', new Set([200]));
    const bad = await fetch(`${BASE}/events/stream?access_token=x.y.z`);
    expect(bad.status).toBe(401);
  });

  it('dashboards', async () => {
    const insp = await expectStatus(200, 'GET', '/analytics/dashboard?scope=inspector', { token: await as('inspector') });
    expect(insp.body.violationsByRegion).toHaveLength(6);
    const orgD = await expectStatus(200, 'GET', '/analytics/dashboard?scope=org&from=2026-01-01&to=2026-12-31', { token: await as('molkombinat.head') });
    expect(orgD.body.byStatus).toHaveLength(11);
    const labD = await expectStatus(200, 'GET', '/analytics/dashboard?scope=lab', { token: await as('agrotest.head') });
    expect(labD.body.scope).toBe('lab');
    const na = await expectStatus(400, 'GET', '/analytics/dashboard?scope=inspector', { token: await as('petrov') });
    expect(na.body.errors).toEqual({ scope: ['validation.scope.notAllowed'] });
    const long = await expectStatus(400, 'GET', '/analytics/dashboard?scope=org&from=2024-01-01&to=2026-01-01', { token: await as('petrov') });
    expect(long.body.errors).toEqual({ from: ['validation.range.tooLong'] });
  });

  it('reports', async () => {
    const insp = await as('inspector');
    const x = await expectStatus(200, 'GET', '/reports/batches?format=xlsx&from=2026-01-01&to=2026-12-31', { token: insp });
    expect(x.headers.get('Content-Disposition')).toBe(`attachment; filename="agrotrace-batches_2026-01-01_2026-12-31.xlsx"; filename*=UTF-8''agrotrace-batches_2026-01-01_2026-12-31.xlsx`);
    expect(Array.from(x.bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);
    const recallId = mock.api.store.t.recalls[0]!.id;
    const p = await expectStatus(200, 'GET', `/reports/recall?format=pdf&id=${recallId}`, { token: insp });
    expect(p.text.startsWith('%PDF-')).toBe(true);
    await expectStatus(200, 'GET', '/reports/recalls?format=pdf&from=2026-01-01&to=2026-12-31', { token: insp });
    await expectStatus(200, 'GET', '/reports/complaints?format=xlsx', { token: insp });
    await expectStatus(200, 'GET', '/reports/lab-tests?format=xlsx', { token: await as('agrotest.head') });
    await expectStatus(200, 'GET', '/reports/org?format=xlsx&from=2026-01-01&to=2026-12-31', { token: await as('zarya.head') });
    await expectStatus(400, 'GET', `/reports/recall?format=pdf&id=${recallId}&from=2026-01-01`, { token: insp });
    await expectStatus(400, 'GET', '/reports/org?format=xlsx', { token: insp });
    await expectStatus(403, 'GET', '/reports/recalls?format=xlsx', { token: await as('zarya.head') });
    await expectStatus(403, 'GET', '/reports/batches?format=xlsx', { token: await as('zarya.agronom') });
    await expectStatus(404, 'GET', `/reports/recall?format=xlsx&id=${UNKNOWN}`, { token: insp });
  });
});

describe('admin, audit, dictionaries, public', () => {
  it('organizations of the admin, approval, suspension', async () => {
    const admin = await as('admin');
    const apps = await expectStatus(200, 'GET', '/admin/organizations?status=PENDING&status=MANUAL_CHECK', { token: admin });
    const pending = apps.body.items[0];
    expect(pending.head.email).toBe('new.shop@agrotrace.test');
    await expectStatus(200, 'POST', `/admin/organizations/${pending.id}/approve`, { token: admin });
    const again = await expectStatus(409, 'POST', `/admin/organizations/${pending.id}/approve`, { token: admin });
    expect(again.body.params).toEqual({ from: 'ACTIVE', to: 'ACTIVE' });
    await expectStatus(200, 'POST', '/auth/login', { body: { email: 'new.shop@agrotrace.test', password: 'Password-2026' } });
    const susp = await expectStatus(200, 'PATCH', `/admin/organizations/${pending.id}`, { token: admin, body: { status: 'SUSPENDED', name: 'ООО «Магазин»' } });
    expect(susp.body.status).toBe('SUSPENDED');
    await expectStatus(403, 'POST', '/auth/login', { body: { email: 'new.shop@agrotrace.test', password: 'Password-2026' } });
    await expectStatus(409, 'PATCH', `/admin/organizations/${pending.id}`, { token: admin, body: { status: 'REJECTED' } });
    await expectStatus(400, 'PATCH', `/admin/organizations/${pending.id}`, { token: admin, body: { regionCode: 'ZZ' } });
    await expectStatus(404, 'PATCH', `/admin/organizations/${UNKNOWN}`, { token: admin, body: { name: 'x' } });
    await expectStatus(200, 'GET', '/admin/organizations?type=FARM&regionCode=33&q=%D0%97%D0%B0%D1%80%D1%8F&sort=name,asc', { token: admin });
    await expectStatus(403, 'GET', '/admin/organizations', { token: await as('inspector') });
  });

  it('audit log', async () => {
    const insp = await as('inspector');
    const page = await expectStatus(200, 'GET', '/audit-log?action=approveOrganization', { token: insp });
    expect(page.body.total).toBe(1);
    const seed = await expectStatus(200, 'GET', '/audit-log?backend=seed&size=3&sort=createdAt,asc', { token: await as('admin') });
    expect(seed.body.items[0].action).toBe('seed');
    await expectStatus(400, 'GET', '/audit-log?entityType=x', { token: insp });
  });

  it('dictionaries CRUD, import, product photo', async () => {
    const admin = await as('admin');
    const t = await as('petrov');
    await expectStatus(200, 'GET', '/dictionaries/norms?size=5', { token: t });
    await expectStatus(200, 'GET', '/dictionaries/regions?q=%D0%92%D0%BB%D0%B0%D0%B4', { token: t });
    await expectStatus(400, 'GET', '/dictionaries/products?includeDeleted=true', { token: t });
    await expectStatus(400, 'GET', '/dictionaries/regions?category=GRAIN', { token: t });
    await expectStatus(400, 'GET', '/dictionaries/cars', { token: t });
    const created = await expectStatus(201, 'POST', '/dictionaries/substances', { token: admin, body: { name: 'Тестовый препарат', type: 'PESTICIDE', waitingPeriodDays: 10 } });
    await expectStatus(400, 'POST', '/dictionaries/substances', { token: admin, body: { name: 'Тестовый препарат', type: 'PESTICIDE', waitingPeriodDays: 10 } });
    await expectStatus(200, 'PUT', `/dictionaries/substances/${created.body.id}`, { token: admin, body: { name: 'Тестовый препарат', type: 'FERTILIZER', waitingPeriodDays: 0 } });
    await expectStatus(204, 'DELETE', `/dictionaries/substances/${created.body.id}`, { token: admin });
    await expectStatus(404, 'DELETE', `/dictionaries/substances/${created.body.id}`, { token: admin });
    const restored = await expectStatus(201, 'POST', '/dictionaries/substances', { token: admin, body: { name: 'Тестовый препарат', type: 'PESTICIDE', waitingPeriodDays: 5 } });
    expect(restored.body.id).toBe(created.body.id);
    const deleted = await expectStatus(200, 'GET', '/dictionaries/substances?includeDeleted=true&size=100', { token: admin });
    expect(deleted.body.total).toBeGreaterThan(0);
    const region = mock.api.store.t.regions.find((r) => r.code === '33')!;
    const inUse = await expectStatus(409, 'DELETE', `/dictionaries/regions/${region.id}`, { token: admin });
    expect(inUse.body.params.usedBy).toEqual(['organizations', 'fields']);
    const r = await expectStatus(201, 'POST', '/dictionaries/regions', { token: admin, body: { code: '77', name: 'Москва' } });
    await expectStatus(204, 'DELETE', `/dictionaries/regions/${r.body.id}`, { token: admin });
    await expectStatus(403, 'POST', '/dictionaries/regions', { token: t, body: { code: '78', name: 'x' } });

    const csv = '﻿name;type;waitingPeriodDays\r\nНовый пестицид;PESTICIDE;15\r\n;;\r\nНовый пестицид;PESTICIDE;16\r\nПлохой;XXX;1\n"Кавычки ""да""";FERTILIZER;0';
    const report = await expectStatus(200, 'POST', '/dictionaries/substances/import', { token: admin, form: form(new TextEncoder().encode(csv), 's.csv') });
    expect(report.body).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    expect(report.body.errors).toEqual([
      { row: 4, column: 'name', message: 'validation.duplicate' },
      { row: 5, column: 'type', message: 'validation.enum' },
    ]);
    const header = await expectStatus(400, 'POST', '/dictionaries/substances/import', { token: admin, form: form(new TextEncoder().encode('a;b\n1;2'), 's.csv') });
    expect(header.body.errors).toEqual({ file: ['validation.import.header'] });
    await expectStatus(415, 'POST', '/dictionaries/substances/import', { token: admin, form: form(new Uint8Array([1, 0, 2]), 's.bin') });

    const product = mock.api.store.t.products[0]!;
    const photo = await expectStatus(200, 'PUT', `/dictionaries/products/${product.id}/image`, { token: admin, form: form(webp, 'p.webp') });
    expect(photo.body.imageUrl).toMatch(/^\/api\/v1\/public\/files\//);
    await expectStatus(404, 'PUT', `/dictionaries/products/${UNKNOWN}/image`, { token: admin, form: form(webp, 'p.webp') });
  });

  it('public page and regions', async () => {
    const page = await expectStatus(200, 'GET', `/public/batches/${code(2)}`);
    expect(page.body.safety).toBe('SAFE');
    expect(page.body.path.length).toBeGreaterThan(1);
    await expectStatus(400, 'GET', '/public/batches/nope');
    await expectStatus(404, 'GET', '/public/batches/AT-2026-999999');
    const regions = await expectStatus(200, 'GET', '/public/regions');
    expect(regions.body.map((r: { name: string }) => r.name)[0]).toBe('Владимирская область');
  });
});

afterAll(() => {
  const missing = OPERATIONS.filter((op) => ![...(coverage.get(op.operationId) ?? [])].some((s) => s >= 200 && s < 300)).map((op) => op.operationId);
  expect(missing).toEqual([]);
});

afterAll(() => {
  const noError = OPERATIONS.filter((op) => ![...(coverage.get(op.operationId) ?? [])].some((s) => s >= 300)).map((op) => op.operationId);
  console.log('operations without an error case:', noError.join(', '));
});

describe('representative errors of the remaining operations', () => {
  it('401, 400, 404 and 409 cases', async () => {
    await expectStatus(400, 'POST', '/auth/password/forgot', { body: { email: 'bad' } });
    await expectStatus(401, 'DELETE', '/me/avatar');
    await expectStatus(401, 'GET', '/me/channels');
    await expectStatus(401, 'POST', '/me/telegram-code');
    const head = await as('petrov');
    const invite = await expectStatus(400, 'POST', '/users', { token: head, body: { email: 'petrov@agrotrace.test', fullName: 'X', roles: ['LAB'], isOrgAdmin: false } });
    expect(invite.body.errors).toEqual({ email: ['validation.email.taken'], roles: ['validation.notAllowed'] });
    await expectStatus(404, 'PUT', `/fields/${mock.api.store.t.fields.find((f) => f.organization_id !== org('Петров').id)!.id}`, { token: head, body: { name: 'x', areaHa: '1.00', regionCode: '33' } });
    await expectStatus(404, 'GET', `/batches/${UNKNOWN}/history`, { token: head });
    await expectStatus(404, 'GET', `/batches/${batchId(20)}/path`, { token: head });
    const prov = await as('provizia.head');
    const b2 = mock.api.store.t.batches.find((b) => b.public_code === code(2))!;
    const onSale = await expectStatus(409, 'POST', `/batches/${b2.id}/on-sale`, { token: prov, headers: { 'If-Match': String(b2.version) } });
    expect(onSale.body.params).toEqual({ from: 'OnSale', to: 'OnSale' });
    await expectStatus(400, 'POST', `/batches/${b2.id}/on-sale`, { token: prov, headers: { 'If-Match': 'W/"1"' } });
    const queued = mock.api.store.t.lab_tests.find((t) => !t.protocol_file_id)!;
    await expectStatus(404, 'GET', `/lab-tests/${queued.id}/protocol`, { token: await as('inspector') });
    await expectStatus(404, 'GET', `/recalls/${UNKNOWN}/graph`, { token: await as('inspector') });
    await expectStatus(400, 'GET', '/notifications?type=NOPE', { token: head });
    const admin = await as('admin');
    await expectStatus(404, 'PUT', `/dictionaries/indicators/${UNKNOWN}`, { token: admin, body: { name: 'x', unit: 'y' } });
    const ind = mock.api.store.t.indicators;
    const dup = await expectStatus(400, 'PUT', `/dictionaries/indicators/${ind[0]!.id}`, { token: admin, body: { name: ind[1]!.name, unit: 'y' } });
    expect(dup.body.errors).toEqual({ name: ['validation.duplicate'] });
    const res = await mock.api.handle(new Request(`${BASE}/events/stream`));
    expect(res.status).toBe(401);
    coverage.get('streamEvents')!.add(401);
  });
});
