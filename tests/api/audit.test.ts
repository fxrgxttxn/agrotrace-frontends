/**
 * The audit log (contracts/openapi/paths/audit.yaml, schema AuditEntry; spec 8.8): read by ADMIN and INSPECTOR only,
 * filters and sorting, the entry format (actor, ip from X-Forwarded-For, requestId = X-Request-Id, backend), and the
 * rows written by the mutating operations of Tasks 2–3 that other suites do not already check (registration,
 * invitation acceptance, password reset, TOTP setup — secrets always "***").
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { API_BACKEND } from './lib/env.js';
import { closeDb } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { freshHead, invite, PASSWORD, registerOrg, uniqueEmail } from './lib/fixtures.js';
import { linkToken, waitForMails } from './lib/mail.js';
import { closeRedis } from './lib/redis.js';
import { awayFromStepEdge, currentStep, totpAt } from './lib/totp.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function auditLog(client: ApiClient, query: Record<string, string | number> = {}) {
  const res = await client.get('/audit-log', { query });
  await expectContract(res, 'listAuditLog');
  return res;
}

const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

describe('x-roles: INSPECTOR and ADMIN read', () => {
  it.each(ROLES)('%s', async (role) => {
    const client = await loginAs(role, { head: false });
    const res = await auditLog(client);
    if (role === 'INSPECTOR' || role === 'ADMIN') {
      expect(res.status, res.text).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    } else expectProblem(res, 403, 'FORBIDDEN', null);
  });

  it('no token → 401', async () => {
    expectProblem(await auditLog(api()), 401, 'UNAUTHORIZED');
  });
});

describe('entries and filters', () => {
  it('an entry: actor with organization, ip = the client address, requestId = X-Request-Id, backend', async () => {
    const { client, user } = await freshHead('FARM');
    client.clientIp = '10.20.30.40';
    const requestId = `audit-${randomBytes(6).toString('hex')}`;
    const res = await client.patch(
      '/me',
      { fullName: 'Аудитов Аудит' },
      { headers: { 'x-request-id': requestId } },
    );
    await expectContract(res, 'updateMe');
    expect(res.status, res.text).toBe(200);

    const inspector = await loginAs('INSPECTOR');
    const [entry] = await auditEntries({ action: 'updateMe', entityId: user.id }, inspector);
    expect(entry).toMatchObject({
      actor: { id: user.id, fullName: 'Аудитов Аудит', organization: { id: res.body.organization.id } },
      action: 'updateMe',
      entityType: 'user',
      entityId: user.id,
      diff: { fullName: ['Тестов Тест Тестович', 'Аудитов Аудит'] },
      ip: '10.20.30.40',
      backend: API_BACKEND,
      requestId,
    });
  });

  it('filters combine by AND: actorId, entityType, entityId, action, backend, from/to by UTC date', async () => {
    const admin = await loginAs('ADMIN');
    const { client, user } = await freshHead('RETAILER');
    expect((await client.patch('/me', { phone: '+79001234567' })).status).toBe(200);
    expect((await client.put('/me/channels', { email: false, telegram: false })).status).toBe(200);

    const mine = await auditEntries({ actorId: user.id }, admin);
    expect(mine.map((e) => e.action)).toEqual([
      'registerOrganization',
      'registerOrganization',
      'updateMe',
      'updateMyChannels',
    ]);
    expect(
      (await auditEntries({ actorId: user.id, entityType: 'organization' }, admin)).map((e) => e.action),
    ).toEqual(['registerOrganization']);
    expect(await auditEntries({ actorId: user.id, action: 'updateMe' }, admin)).toHaveLength(1);
    expect(await auditEntries({ actorId: user.id, action: 'updatem' }, admin)).toEqual([]);
    expect((await auditEntries({ entityId: user.id, backend: API_BACKEND }, admin)).length).toBe(3);
    expect(await auditEntries({ entityId: user.id, backend: 'seed' }, admin)).toEqual([]);
    // The UTC dates of the rows themselves (the run may cross midnight UTC): from the first row's day to the last's.
    const first = mine[0]!.createdAt.slice(0, 10);
    const last = mine.at(-1)!.createdAt.slice(0, 10);
    expect((await auditEntries({ actorId: user.id, from: first, to: last }, admin)).length).toBe(4);
    expect(await auditEntries({ actorId: user.id, to: dayBefore(first) }, admin)).toEqual([]);
    expect(await auditEntries({ actorId: user.id, to: '2020-01-01' }, admin)).toEqual([]);
    expect(await auditEntries({ actorId: user.id, from: '2999-01-01' }, admin)).toEqual([]);

    const seed = await auditLog(admin, { backend: 'seed', size: 5 });
    for (const e of seed.body.items) {
      expect(e.backend).toBe('seed');
      expect(e.ip).toBeNull();
      expect(e.requestId).toBeNull();
    }
  });

  it('sort by createdAt (desc by default, ties by id); asc on request', async () => {
    const admin = await loginAs('INSPECTOR');
    const desc = await auditLog(admin, { size: 50 });
    const t = desc.body.items.map((e: { createdAt: string }) => Date.parse(e.createdAt)) as number[];
    expect(t).toEqual([...t].sort((a, b) => b - a));
    const asc = await auditLog(admin, { size: 50, sort: 'createdAt,asc' });
    const items = asc.body.items as { id: number; createdAt: string }[];
    for (let i = 1; i < items.length; i++) {
      const [p, c] = [items[i - 1]!, items[i]!];
      expect(
        Date.parse(p.createdAt) < Date.parse(c.createdAt) || (p.createdAt === c.createdAt && p.id < c.id),
      ).toBe(true);
    }
  });

  it('malformed filters → 400 per parameter; from after to → errors.from range', async () => {
    const admin = await loginAs('ADMIN');
    expectErrors(
      await auditLog(admin, {
        actorId: 'x',
        entityId: 'y',
        entityType: 'Batch',
        backend: 'rails',
        action: 'a'.repeat(65),
        sort: 'id,asc',
      }),
      {
        actorId: ['validation.uuid'],
        entityId: ['validation.uuid'],
        entityType: ['validation.enum'],
        backend: ['validation.enum'],
        action: ['validation.maxLength'],
        sort: ['validation.sort'],
      },
    );
    expectErrors(await auditLog(admin, { from: '2026-09-30', to: '2026-09-01' }), {
      from: ['validation.range'],
    });
    expectErrors(await auditLog(admin, { from: '2026-02-30', to: '26-01-01' }), {
      from: ['validation.date.format'],
      to: ['validation.date.format'],
    });
    expect((await auditLog(admin, { entityId: UUID0 })).body.total).toBe(0);
  });
});

describe('Tasks 2–3: rows of the mutating operations (secrets "***")', () => {
  it('registerOrganization: the organization and its head; the password masked', async () => {
    const org = await registerOrg('FARM');
    const rows = await auditEntries({ action: 'registerOrganization', entityId: org.organizationId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'organization', backend: API_BACKEND });
    expect(rows[0]!.diff).toMatchObject({
      type: [null, 'FARM'],
      inn: [null, org.inn],
      regionCode: [null, '33'],
      status: [null, org.status],
    });
    const actor = rows[0]!.actor!;
    const [user] = await auditEntries({ action: 'registerOrganization', entityId: actor.id });
    expect(user!.entityType).toBe('user');
    expect(user!.diff).toMatchObject({
      email: [null, org.email],
      roles: [null, ['FARMER']],
      isOrgAdmin: [null, true],
      organizationId: [null, org.organizationId],
      password: [null, '***'],
    });
    expect(JSON.stringify(user!.diff)).not.toContain(org.password);
  });

  it('acceptInvite and resetPassword: the password appears only as "***"', async () => {
    const { client: head } = await freshHead('LAB');
    const { user, token } = await invite(head, 'LAB');
    const accepted = await api().post('/auth/accept-invite', {
      token,
      fullName: 'Лаборант Новый',
      password: PASSWORD,
    });
    expect(accepted.status, accepted.text).toBe(204);
    const [row] = await auditEntries({ action: 'acceptInvite', entityId: user.id });
    expect(row).toMatchObject({ actor: { id: user.id }, entityType: 'user' });
    expect(row!.diff).toEqual({
      fullName: ['Приглашённый Сотрудник', 'Лаборант Новый'],
      status: ['INVITED', 'ACTIVE'],
      password: ['***', '***'],
    });

    const forgot = await api().post('/auth/password/forgot', { email: user.email });
    expect(forgot.status).toBe(204);
    const mails = await waitForMails(user.email, 2);
    const reset = linkToken(mails[0]!, 'password/reset'); // newest first
    const newPassword = `Новый-пароль-${randomUUID()}`;
    const done = await api().post('/auth/password/reset', { token: reset.token, password: newPassword });
    expect(done.status, done.text).toBe(204);
    const [resetRow] = await auditEntries({ action: 'resetPassword', entityId: user.id });
    expect(resetRow!.diff).toEqual({ password: ['***', '***'] });
    expect(JSON.stringify(resetRow)).not.toContain(newPassword);
  });

  it('setupTwoFactor: the secret masked in both steps', async () => {
    // setupTwoFactor is for INSPECTOR and ADMIN: the head of a new authority.
    const { client, user } = await freshHead('AUTHORITY');
    const start = await client.post('/auth/2fa/setup', {});
    expect(start.status, start.text).toBe(200);
    await awayFromStepEdge();
    const confirm = await client.post('/auth/2fa/setup', { code: totpAt(start.body.secret, currentStep()) });
    expect(confirm.status, confirm.text).toBe(200);
    const rows = await auditEntries({ action: 'setupTwoFactor', entityId: user.id });
    expect(rows.map((r) => r.diff)).toEqual([{ totpSecret: [null, '***'] }, { totpEnabled: [false, true] }]);
    expect(JSON.stringify(rows)).not.toContain(start.body.secret);
  });

  it('inviteUser for a fresh email; the invited email is lower-cased in the diff', async () => {
    const { client: head } = await freshHead('PROCESSOR');
    const email = uniqueEmail('Mixed.Case');
    const { user } = await invite(head, 'PROCESSOR', { email });
    const [row] = await auditEntries({ action: 'inviteUser', entityId: user.id });
    expect(row!.diff.email).toEqual([null, email.toLowerCase()]);
  });
});
