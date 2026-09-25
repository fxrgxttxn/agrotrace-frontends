/**
 * Users (contracts/openapi/paths/users.yaml): x-roles/x-org-admin matrix (403 without params for employees), listUsers
 * (own organization for heads, every user for ADMIN, filters R51), inviteUser (INVITED + letter + `invite:` key R82 →
 * acceptInvite), updateUser (R37 transitions, blocking revokes refresh tokens, 404 outside the organization),
 * getUserAvatar (any authenticated user).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { demoUser, loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { fixture, sha256hex, upload, webpSize } from './lib/files.js';
import {
  freshEmployee,
  freshHead,
  invite,
  login,
  PASSWORD,
  ROLE_OF_TYPE,
  uniqueEmail,
  type RegistrableType,
} from './lib/fixtures.js';
import { linkToken, waitForMails } from './lib/mail.js';
import { closeRedis, redis, sha256hex as sha } from './lib/redis.js';
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const TYPES: RegistrableType[] = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY'];
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function listUsers(client: ApiClient, q: Record<string, string | number | undefined> = {}) {
  const res = await client.get('/users', { query: q });
  await expectContract(res, 'listUsers');
  return res;
}

async function patchUser(client: ApiClient, id: string, body: unknown) {
  const res = await client.patch(`/users/${id}`, body);
  await expectContract(res, 'updateUser');
  return res;
}

describe('x-roles / x-org-admin matrix', () => {
  // Every role has a demo employee (isOrgAdmin false). x-org-admin exempts ADMIN (info.description), so the platform's
  // non-head ADMIN is allowed — checked separately below.
  const NON_ADMIN = ROLES.filter((r) => r !== 'ADMIN');
  it.each(NON_ADMIN)(
    '%s employee (not a head): listUsers, inviteUser, updateUser → 403 without params',
    async (role) => {
      const client = await loginAs(role, { head: false });
      const list = await listUsers(client);
      expectProblem(list, 403, 'FORBIDDEN', null);
      const inv = await client.post('/users', {
        email: uniqueEmail('never'),
        fullName: 'Никто',
        roles: [role],
        isOrgAdmin: false,
      });
      await expectContract(inv, 'inviteUser');
      expectProblem(inv, 403, 'FORBIDDEN', null);
      const patch = await patchUser(client, UUID0, { isOrgAdmin: true });
      expectProblem(patch, 403, 'FORBIDDEN', null);
    },
  );

  it('x-org-admin does not apply to ADMIN: the non-head platform ADMIN lists users', async () => {
    const support = await loginAs('ADMIN', { head: false });
    expect((await listUsers(support)).status).toBe(200);
  });

  it.each(ROLES)('%s head: listUsers → 200; getUserAvatar allowed for any role', async (role) => {
    const client = await loginAs(role, { head: true });
    expect((await listUsers(client)).status).toBe(200);
    const employee = await loginAs(role, { head: false });
    const avatar = await employee.get(`/users/${UUID0}/avatar`);
    await expectContract(avatar, 'getUserAvatar');
    expectProblem(avatar, 404, 'NOT_FOUND');
  });

  it('no token → 401 on every users operation', async () => {
    const anon = api();
    for (const [op, res] of [
      ['listUsers', await anon.get('/users')],
      ['inviteUser', await anon.post('/users', {})],
      ['updateUser', await anon.patch(`/users/${UUID0}`, {})],
      ['getUserAvatar', await anon.get(`/users/${UUID0}/avatar`)],
    ] as const) {
      await expectContract(res, op);
      expectProblem(res, 401, 'UNAUTHORIZED');
    }
  });
});

describe('listUsers', () => {
  it('a head sees exactly the users of the own organization; organizationId → 400 notAllowed (R51)', async () => {
    const { client, org, user } = await freshHead('FARM');
    const employee = await freshEmployee(client, 'FARM');
    const res = await listUsers(client);
    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((u: { id: string }) => u.id).sort()).toEqual([user.id, employee.id].sort());
    for (const u of res.body.items) expect(u.organization.id).toBe(org.organizationId);

    const filtered = await listUsers(client, { organizationId: org.organizationId });
    expectErrors(filtered, { organizationId: ['validation.organizationId.notAllowed'] });
  });

  it('ADMIN sees every organization; organizationId, status, role and q filter; sort and pages', async () => {
    const admin = await loginAs('ADMIN', { head: true });
    const { client: head, org, user } = await freshHead('PROCESSOR');
    const employee = await freshEmployee(head, 'PROCESSOR');
    const pending = await invite(head, 'PROCESSOR', { fullName: 'Яковлев Приглашённый' });

    const all = await listUsers(admin, { size: 100 });
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(19);
    expect(
      new Set(all.body.items.map((u: { organization: { id: string } }) => u.organization.id)).size,
    ).toBeGreaterThan(5);

    const inOrg = await listUsers(admin, { organizationId: org.organizationId });
    expect(inOrg.body.total).toBe(3);
    // default sort fullName,asc (code points): "Сотрудник…" < "Тестов…" < "Яковлев…"
    expect(inOrg.body.items.map((u: { id: string }) => u.id)).toEqual([
      employee.id,
      user.id,
      pending.user.id,
    ]);
    const desc = await listUsers(admin, { organizationId: org.organizationId, sort: 'fullName,desc' });
    expect(desc.body.items.map((u: { id: string }) => u.id)).toEqual([pending.user.id, user.id, employee.id]);
    const byCreated = await listUsers(admin, { organizationId: org.organizationId, sort: 'createdAt,asc' });
    expect(byCreated.body.items.map((u: { id: string }) => u.id)).toEqual([
      user.id,
      employee.id,
      pending.user.id,
    ]);

    const invited = await listUsers(admin, { organizationId: org.organizationId, status: 'INVITED' });
    expect(invited.body.items.map((u: { id: string; status: string }) => [u.id, u.status])).toEqual([
      [pending.user.id, 'INVITED'],
    ]);
    const processors = await listUsers(admin, { organizationId: org.organizationId, role: 'PROCESSOR' });
    expect(processors.body.total).toBe(3);
    const farmers = await listUsers(admin, { organizationId: org.organizationId, role: 'FARMER' });
    expect(farmers.body.total).toBe(0);

    // q — substring of fullName or email, case-insensitive
    const byName = await listUsers(admin, { organizationId: org.organizationId, q: 'яковЛЕВ' });
    expect(byName.body.items.map((u: { id: string }) => u.id)).toEqual([pending.user.id]);
    const byEmail = await listUsers(admin, { q: employee.email.slice(3, 20).toUpperCase() });
    expect(byEmail.body.items.map((u: { id: string }) => u.id)).toEqual([employee.id]);
    const literal = await listUsers(admin, { organizationId: org.organizationId, q: '%' });
    expect(literal.body.total).toBe(0);

    const page = await listUsers(admin, { organizationId: org.organizationId, size: 2, page: 2 });
    expect(page.body).toMatchObject({ page: 2, size: 2, total: 3 });
    expect(page.body.items.map((u: { id: string }) => u.id)).toEqual([pending.user.id]);
  });

  it('invalid query → 400 VALIDATION per parameter', async () => {
    const admin = await loginAs('ADMIN', { head: true });
    for (const [q, errors] of [
      [{ sort: 'email' }, { sort: ['validation.sort'] }],
      [{ sort: 'phone,asc' }, { sort: ['validation.sort'] }],
      [{ size: 101 }, { size: ['validation.max'] }],
      [{ page: 0 }, { page: ['validation.min'] }],
      [{ page: 'x' }, { page: ['validation.type'] }],
      [{ status: 'DELETED' }, { status: ['validation.enum'] }],
      [{ role: 'BOSS' }, { role: ['validation.enum'] }],
      [{ organizationId: 'nope' }, { organizationId: ['validation.uuid'] }],
      [{ q: 'x'.repeat(101) }, { q: ['validation.maxLength'] }],
    ] as const) {
      expectErrors(await listUsers(admin, q), errors);
    }
  });

  it('a user with an avatar has a signed avatarUrl; the organization logo is a public URL', async () => {
    const head = await loginAs('FARMER', { key: 'zarya.head' });
    const res = await listUsers(head);
    const zarya = res.body.items.find((u: { email: string }) => u.email === 'zarya.head@agrotrace.test');
    expect(zarya.avatarUrl).toMatch(/^\/api\/v1\/files\/[0-9a-f-]{36}\?exp=\d{10}&sig=[0-9a-f]{64}$/);
    expect(zarya.organization.logoUrl).toMatch(/^\/api\/v1\/public\/files\/[0-9a-f-]{36}$/);
  });
});

describe('inviteUser', () => {
  it.each(TYPES)(
    'a %s head invites into the own organization: INVITED, letter, invite: key, accept → login',
    async (type) => {
      const { client, org } = await freshHead(type);
      const email = uniqueEmail('Invited').replace('invited', 'InViTeD');
      const res = await client.post('/users', {
        email,
        fullName: 'Сидорова Анна Викторовна',
        roles: [ROLE_OF_TYPE[type]],
        isOrgAdmin: false,
      });
      await expectContract(res, 'inviteUser');
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({
        email: email.toLowerCase(),
        fullName: 'Сидорова Анна Викторовна',
        phone: null,
        avatarUrl: null,
        roles: [ROLE_OF_TYPE[type]],
        isOrgAdmin: false,
        status: 'INVITED',
        organization: { id: org.organizationId, type },
      });

      const [mail] = await waitForMails(email.toLowerCase());
      expect(mail!.subject).toContain('приглашение');
      const { url, token } = linkToken(mail!, 'invite');
      expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
      const key = `invite:${sha(token)}`;
      const value = JSON.parse((await redis().get(key))!);
      expect(value.userId).toBe(res.body.id);
      expect(value.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 604700);
      expect(await redis().ttl(key)).toBeGreaterThan(604700);

      // INVITED cannot sign in until the invitation is accepted.
      const early = await login(api(), email, PASSWORD);
      expect(early.status).toBe(401);
      const accepted = await api().post('/auth/accept-invite', {
        token,
        fullName: 'Сидорова А. В.',
        password: PASSWORD,
      });
      await expectContract(accepted, 'acceptInvite');
      expect(accepted.status, accepted.text).toBe(204);
      const signedIn = await login(api(), email.toLowerCase(), PASSWORD);
      expect(signedIn.status, signedIn.text).toBe(200);
      expect(signedIn.body.user).toMatchObject({ fullName: 'Сидорова А. В.', roles: [ROLE_OF_TYPE[type]] });

      const [audit] = await query<{ entity_type: string; diff: Record<string, unknown> }>(
        `SELECT entity_type, diff FROM audit_log WHERE action = 'inviteUser' AND entity_id = $1`,
        [res.body.id],
      );
      expect(audit).toMatchObject({ entity_type: 'user' });
      expect(audit!.diff).toMatchObject({
        email: [null, email.toLowerCase()],
        status: [null, 'INVITED'],
        roles: [null, [ROLE_OF_TYPE[type]]],
        organizationId: [null, org.organizationId],
      });
    },
  );

  it('ADMIN invites into any organization (organizationId) and into the platform without it', async () => {
    const admin = await loginAs('ADMIN', { head: true });
    const { org } = await freshHead('RETAILER');
    const { user } = await invite(admin, 'RETAILER', {
      organizationId: org.organizationId,
      isOrgAdmin: true,
    });
    expect(user).toMatchObject({
      status: 'INVITED',
      organization: { id: org.organizationId, type: 'RETAILER' },
    });

    const res = await admin.post('/users', {
      email: uniqueEmail('support'),
      fullName: 'Поддержка Платформы',
      roles: ['ADMIN'],
      isOrgAdmin: false,
    });
    await expectContract(res, 'inviteUser');
    expect(res.status, res.text).toBe(201);
    expect(res.body.organization.type).toBe('PLATFORM');
  });

  it('roles must match the organization type; ADMIN only by ADMIN; organizationId only for ADMIN; email taken', async () => {
    const { client, org } = await freshHead('FARM');
    const taken = demoUser('LAB').email.toUpperCase();
    const res = await client.post('/users', {
      email: taken,
      fullName: 'Кто-то',
      roles: ['FARMER', 'ADMIN'],
      isOrgAdmin: false,
      organizationId: org.organizationId,
    });
    await expectContract(res, 'inviteUser');
    expectErrors(res, {
      email: ['validation.email.taken'],
      roles: ['validation.notAllowed'],
      organizationId: ['validation.organizationId.notAllowed'],
    });

    const lab = await client.post('/users', {
      email: uniqueEmail(),
      fullName: 'Лаборант',
      roles: ['LAB'],
      isOrgAdmin: false,
    });
    await expectContract(lab, 'inviteUser');
    expectErrors(lab, { roles: ['validation.notAllowed'] });

    const admin = await loginAs('ADMIN', { head: true });
    const unknownOrg = await admin.post('/users', {
      email: uniqueEmail(),
      fullName: 'Никто',
      roles: ['FARMER'],
      isOrgAdmin: false,
      organizationId: '00000000-0000-4000-8000-000000000001',
    });
    await expectContract(unknownOrg, 'inviteUser');
    expectErrors(unknownOrg, { organizationId: ['validation.notFound'] });

    const wrongForOrg = await admin.post('/users', {
      email: uniqueEmail(),
      fullName: 'Не туда',
      roles: ['ADMIN'],
      isOrgAdmin: false,
      organizationId: org.organizationId,
    });
    await expectContract(wrongForOrg, 'inviteUser');
    expectErrors(wrongForOrg, { roles: ['validation.notAllowed'] });
  });

  it('schema errors → 400 before any reference check', async () => {
    const { client } = await freshHead('FARM');
    for (const [body, errors] of [
      [
        {},
        {
          email: ['validation.required'],
          fullName: ['validation.required'],
          roles: ['validation.required'],
          isOrgAdmin: ['validation.required'],
        },
      ],
      [
        { email: 'not-an-email', fullName: ' ', roles: [], isOrgAdmin: 'no' },
        {
          email: ['validation.email'],
          fullName: ['validation.pattern'],
          roles: ['validation.required'],
          isOrgAdmin: ['validation.type'],
        },
      ],
      [
        { email: uniqueEmail(), fullName: 'X', roles: ['FARMER', 'FARMER'], isOrgAdmin: false },
        { roles: ['validation.duplicate'] },
      ],
      [
        { email: uniqueEmail(), fullName: 'X', roles: ['FARMER'], isOrgAdmin: false, status: 'ACTIVE' },
        { status: ['validation.unknownField'] },
      ],
    ] as const) {
      const res = await client.post('/users', body);
      await expectContract(res, 'inviteUser');
      expectErrors(res, errors);
    }
  });
});

describe('updateUser', () => {
  it('head blocks an employee (refresh tokens revoked, login 403), unblocks; same status is a no-op', async () => {
    const { client: head } = await freshHead('FARM');
    const emp = await freshEmployee(head, 'FARM');
    const refreshToken = emp.client.jar.get('at_refresh')!;

    const blocked = await patchUser(head, emp.id, { status: 'BLOCKED' });
    expect(blocked.status, blocked.text).toBe(200);
    expect(blocked.body).toMatchObject({
      id: emp.id,
      status: 'BLOCKED',
      roles: ['FARMER'],
      isOrgAdmin: false,
    });

    const refresh = await api().post('/auth/refresh', undefined, {
      headers: { cookie: `at_refresh=${refreshToken}` },
    });
    await expectContract(refresh, 'refreshToken');
    expectProblem(refresh, 401, 'TOKEN_EXPIRED');
    const denied = await login(api(), emp.email, PASSWORD);
    expectProblem(denied, 403, 'FORBIDDEN', { reason: 'USER_BLOCKED' });

    const same = await patchUser(head, emp.id, { status: 'BLOCKED' });
    expect(same.status).toBe(200);
    expect(same.body.status).toBe('BLOCKED');

    const active = await patchUser(head, emp.id, { status: 'ACTIVE' });
    expect(active.body.status).toBe('ACTIVE');
    expect((await login(api(), emp.email, PASSWORD)).status).toBe(200);

    const audit = await query<{ diff: Record<string, unknown> }>(
      `SELECT diff FROM audit_log WHERE action = 'updateUser' AND entity_id = $1 ORDER BY id`,
      [emp.id],
    );
    expect(audit.map((a) => a.diff)).toEqual([
      { status: ['ACTIVE', 'BLOCKED'] },
      { status: ['BLOCKED', 'ACTIVE'] },
    ]);
  });

  it('roles and isOrgAdmin: promote an employee to head; roles must match the organization type', async () => {
    const { client: head } = await freshHead('PROCESSOR');
    const emp = await freshEmployee(head, 'PROCESSOR');
    const promoted = await patchUser(head, emp.id, { isOrgAdmin: true, roles: ['PROCESSOR'] });
    expect(promoted.status, promoted.text).toBe(200);
    expect(promoted.body).toMatchObject({ isOrgAdmin: true, roles: ['PROCESSOR'] });
    // The new head's next session carries org_admin and may list users.
    const again = api();
    expect((await login(again, emp.email, PASSWORD)).status).toBe(200);
    expect((await listUsers(again)).status).toBe(200);

    const wrong = await patchUser(head, emp.id, { roles: ['FARMER'] });
    expectErrors(wrong, { roles: ['validation.notAllowed'] });
    const admin = await patchUser(head, emp.id, { roles: ['PROCESSOR', 'ADMIN'] });
    expectErrors(admin, { roles: ['validation.notAllowed'] });
  });

  it('INVITED: any status change → 409 INVALID_TRANSITION {from, to}; roles may still change', async () => {
    const { client: head } = await freshHead('FARM');
    const { user } = await invite(head, 'FARM');
    for (const to of ['ACTIVE', 'BLOCKED']) {
      const res = await patchUser(head, user.id, { status: to });
      expectProblem(res, 409, 'INVALID_TRANSITION', { from: 'INVITED', to });
    }
    const ok = await patchUser(head, user.id, { isOrgAdmin: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'INVITED', isOrgAdmin: true });
  });

  it('own roles, head flag or status cannot be changed → 400 notAllowed', async () => {
    const { client: head, user } = await freshHead('FARM');
    const res = await patchUser(head, user.id, { status: 'BLOCKED', isOrgAdmin: false, roles: ['FARMER'] });
    expectErrors(res, {
      status: ['validation.notAllowed'],
      isOrgAdmin: ['validation.notAllowed'],
      roles: ['validation.notAllowed'],
    });
  });

  it('a user of another organization is invisible to a head → 404; ADMIN may update anyone', async () => {
    const { client: headA } = await freshHead('FARM');
    const { client: headB } = await freshHead('FARM');
    const empB = await freshEmployee(headB, 'FARM');
    expectProblem(await patchUser(headA, empB.id, { status: 'BLOCKED' }), 404, 'NOT_FOUND');
    expectProblem(await patchUser(headA, UUID0, { status: 'BLOCKED' }), 404, 'NOT_FOUND');
    expectErrors(await patchUser(headA, 'not-a-uuid', { status: 'BLOCKED' }), { id: ['validation.uuid'] });
    // schema before 404
    expectErrors(await patchUser(headA, empB.id, {}), { _root: ['validation.minProperties'] });
    expectErrors(await patchUser(headA, empB.id, { status: 'INVITED' }), { status: ['validation.enum'] });

    const admin = await loginAs('ADMIN', { head: true });
    const res = await patchUser(admin, empB.id, { status: 'BLOCKED' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('BLOCKED');
  });
});

describe('getUserAvatar', () => {
  it('any authenticated role gets the WebP variant (480 default, 96), ETag/304, private caching', async () => {
    const { client: owner, user } = await freshHead('FARM');
    const up = await upload(owner, '/me/avatar', {
      data: fixture('landscape-640x320.png'),
      filename: 'Портрет.png',
    });
    await expectContract(up, 'uploadMyAvatar');
    expect(up.status, up.text).toBe(200);

    const viewer = await loginAs('LAB', { head: false });
    const res = await viewer.get(`/users/${user.id}/avatar`);
    await expectContract(res, 'getUserAvatar');
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/webp');
    expect(webpSize(res.bytes)).toEqual({ width: 480, height: 240 });
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(res.headers.get('etag')).toBe(`"${sha256hex(res.bytes)}"`);
    expect(Number(res.headers.get('content-length'))).toBe(res.bytes.length);

    const small = await viewer.get(`/users/${user.id}/avatar`, { query: { variant: 96 } });
    await expectContract(small, 'getUserAvatar');
    expect(webpSize(small.bytes)).toEqual({ width: 96, height: 48 });

    const cached = await viewer.get(`/users/${user.id}/avatar`, {
      headers: { 'if-none-match': res.headers.get('etag')! },
    });
    await expectContract(cached, 'getUserAvatar');
    expect(cached.status).toBe(304);
    expect(cached.bytes.length).toBe(0);
  });

  it('no avatar, unknown user → 404; malformed id or variant → 400', async () => {
    const { client, user } = await freshHead('FARM');
    expectProblem(await client.get(`/users/${user.id}/avatar`), 404, 'NOT_FOUND');
    const bad = await client.get('/users/nope/avatar');
    await expectContract(bad, 'getUserAvatar');
    expectErrors(bad, { id: ['validation.uuid'] });
    const variant = await client.get(`/users/${user.id}/avatar`, { query: { variant: 100 } });
    await expectContract(variant, 'getUserAvatar');
    expectErrors(variant, { variant: ['validation.enum'] });
  });
});

describe('demo data stays intact', () => {
  it('the demo employee used by the matrix can still sign in', async () => {
    const u = demoUser('FARMER', { head: false });
    expect((await login(api(), u.email, DEMO_PASSWORD)).status).toBe(200);
  });
});
