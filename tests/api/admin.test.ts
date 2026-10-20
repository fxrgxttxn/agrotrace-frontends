/**
 * Administration (contracts/openapi/paths/admin.yaml, R54/D25–D26, R59) and the public regions list (public.yaml):
 * listAdminOrganizations (filters, sorting, head/usersCount), approveOrganization (PENDING/MANUAL_CHECK → ACTIVE, then
 * sign-in works), updateAdminOrganization (fields, transitions of entity-state-machines.json `organization`, check
 * order 404 → 409 → 400 by reference, the effect of SUSPENDED/REJECTED on sign-in and refresh), audit rows.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { activateOrg, freshHead, login, platformAdmin, registerOrg } from './lib/fixtures.js';
import { closeRedis, redis } from './lib/redis.js';
import states from '../../contracts/rules/entity-state-machines.json' with { type: 'json' };

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const STATUSES = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'] as const;
const UUID0 = '00000000-0000-4000-8000-000000000000';
const utf8Order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function listOrgs(client: ApiClient, query: Record<string, string | number> | string = {}) {
  const res =
    typeof query === 'string'
      ? await client.get(`/admin/organizations?${query}`)
      : await client.get('/admin/organizations', { query });
  await expectContract(res, 'listAdminOrganizations');
  return res;
}

async function patchOrg(client: ApiClient, id: string, body: unknown) {
  const res = await client.patch(`/admin/organizations/${id}`, body);
  await expectContract(res, 'updateAdminOrganization');
  return res;
}

async function approve(client: ApiClient, id: string) {
  const res = await client.post(`/admin/organizations/${id}/approve`);
  await expectContract(res, 'approveOrganization');
  return res;
}

describe('x-roles: ADMIN only', () => {
  it.each(ROLES.filter((r) => r !== 'ADMIN'))(
    '%s head → 403 without params on every admin operation',
    async (role) => {
      const client = await loginAs(role, { head: true });
      expectProblem(await listOrgs(client), 403, 'FORBIDDEN', null);
      expectProblem(await patchOrg(client, UUID0, { name: 'X' }), 403, 'FORBIDDEN', null);
      expectProblem(await approve(client, UUID0), 403, 'FORBIDDEN', null);
    },
  );

  it('the non-head platform ADMIN may administer (no x-org-admin)', async () => {
    const support = await loginAs('ADMIN', { head: false });
    expect((await listOrgs(support)).status).toBe(200);
  });
});

describe('listAdminOrganizations', () => {
  it('every non-deleted organization with head and usersCount; PLATFORM included; newest first by default', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('LAB');
    const res = await listOrgs(client, { size: 100 });
    expect(res.status, res.text).toBe(200);
    const created = res.body.items.map((o: { createdAt: string }) => Date.parse(o.createdAt)) as number[];
    expect(created).toEqual([...created].sort((a, b) => b - a));
    const mine = res.body.items.find((o: { id: string }) => o.id === org.organizationId);
    expect(mine).toMatchObject({
      type: 'LAB',
      inn: org.inn,
      status: 'MANUAL_CHECK',
      trustRating: null,
      usersCount: 1,
      head: { fullName: org.fullName, email: org.email, phone: null },
    });
    const all = await listOrgs(client, { size: 100, type: 'PLATFORM' });
    expect(all.body.total).toBeGreaterThan(0);
    for (const o of all.body.items) expect(o.type).toBe('PLATFORM');
  });

  it('filters: status and type repeat, regionCode, q (name substring or INN prefix); name order', async () => {
    const client = await platformAdmin();
    const tag = randomBytes(3).toString('hex');
    const a = await registerOrg('FARM', { name: `Заявка ${tag} Б` });
    const b = await registerOrg('RETAILER', { name: `Заявка ${tag} А` });
    await activateOrg(b.organizationId);

    const q = await listOrgs(client, { q: `заявка ${tag.toUpperCase()}`, sort: 'name,asc' });
    expect(q.body.items.map((o: { id: string }) => o.id)).toEqual([b.organizationId, a.organizationId]);
    const byInn = await listOrgs(client, { q: a.inn.slice(0, 10) });
    expect(byInn.body.items.map((o: { id: string }) => o.id)).toContain(a.organizationId);
    expect(
      (await listOrgs(client, { q: a.inn.slice(1) })).body.items.map((o: { id: string }) => o.id),
    ).not.toContain(a.organizationId);

    const pending = await listOrgs(client, `status=PENDING&status=MANUAL_CHECK&q=${encodeURIComponent(tag)}`);
    expect(pending.body.items.map((o: { id: string }) => o.id)).toEqual([a.organizationId]);
    const types = await listOrgs(
      client,
      `type=FARM&type=RETAILER&q=${encodeURIComponent(tag)}&sort=name,desc`,
    );
    expect(types.body.items.map((o: { id: string }) => o.id)).toEqual([a.organizationId, b.organizationId]);
    const region = await listOrgs(client, { regionCode: '33', q: tag });
    expect(region.body.total).toBe(2);
    expect((await listOrgs(client, { regionCode: '50', q: tag })).body.total).toBe(0);

    const names = (await listOrgs(client, { sort: 'name,asc', size: 100 })).body.items.map(
      (o: { name: string }) => o.name,
    ) as string[];
    expect(names).toEqual([...names].sort(utf8Order));
  });

  it('malformed filters → 400 per parameter', async () => {
    const client = await platformAdmin();
    expectErrors(
      await listOrgs(client, 'status=ACTIVE&status=NEW&type=FARM&type=FARM&regionCode=ab&sort=inn,asc'),
      {
        status: ['validation.enum'],
        type: ['validation.duplicate'],
        regionCode: ['validation.pattern'],
        sort: ['validation.sort'],
      },
    );
  });
});

describe('approveOrganization', () => {
  it('MANUAL_CHECK → ACTIVE: sign-in works from then on; again → 409 {from: ACTIVE, to: ACTIVE}; audit', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('PROCESSOR');
    const before = await login(api(), org.email, org.password);
    expectProblem(before, 403, 'FORBIDDEN', { reason: 'ORGANIZATION_NOT_ACTIVE' });
    const res = await approve(client, org.organizationId);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: org.organizationId, status: 'ACTIVE', usersCount: 1 });
    expect((await login(api(), org.email, org.password)).status).toBe(200);
    expectProblem(await approve(client, org.organizationId), 409, 'INVALID_TRANSITION', {
      from: 'ACTIVE',
      to: 'ACTIVE',
    });

    const audit = await auditEntries({ action: 'approveOrganization', entityId: org.organizationId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: 'organization',
      diff: { status: ['MANUAL_CHECK', 'ACTIVE'] },
    });
  });

  it('REJECTED cannot be approved; unknown or malformed id → 404', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('FARM');
    expect((await patchOrg(client, org.organizationId, { status: 'REJECTED' })).status).toBe(200);
    expectProblem(await approve(client, org.organizationId), 409, 'INVALID_TRANSITION', {
      from: 'REJECTED',
      to: 'ACTIVE',
    });
    expectProblem(await approve(client, UUID0), 404, 'NOT_FOUND');
    // approveOrganization declares no 400: a malformed id names no organization → 404.
    expectProblem(await approve(client, 'abc'), 404, 'NOT_FOUND');
  });

  it('parallel approvals: exactly one succeeds, the other → 409 (organization row lock)', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('RETAILER');
    const [x, y] = await Promise.all([
      approve(client, org.organizationId),
      approve(client, org.organizationId),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });
});

describe('updateAdminOrganization', () => {
  it('changes name, address, region; returns OrganizationAdmin; audit diff of the changed fields only', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('RETAILER');
    const res = await patchOrg(client, org.organizationId, {
      name: 'Новое название',
      address: 'г. Владимир, ул. Мира, д. 1',
      regionCode: '50',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Новое название',
      address: 'г. Владимир, ул. Мира, д. 1',
      region: { code: '50', name: 'Московская область' },
      status: 'MANUAL_CHECK',
    });
    const same = await patchOrg(client, org.organizationId, {
      address: null,
      status: 'MANUAL_CHECK' as never,
    });
    expectErrors(same, { status: ['validation.enum'] });
    const cleared = await patchOrg(client, org.organizationId, { address: null });
    expect(cleared.body.address).toBeNull();
    const audit = await auditEntries({ action: 'updateAdminOrganization', entityId: org.organizationId });
    expect(audit.map((a) => a.diff)).toEqual([
      {
        name: [expect.any(String), 'Новое название'],
        address: [null, 'г. Владимир, ул. Мира, д. 1'],
        regionCode: ['33', '50'],
      },
      { address: ['г. Владимир, ул. Мира, д. 1', null] },
    ]);
  });

  it('body errors → 400 (empty object, unknown field, blank name, empty address)', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('FARM');
    expectErrors(await patchOrg(client, org.organizationId, {}), { _root: ['validation.minProperties'] });
    expectErrors(await patchOrg(client, org.organizationId, { inn: '1234567890', name: ' ', address: '' }), {
      inn: ['validation.unknownField'],
      name: ['validation.pattern'],
      address: ['validation.pattern'],
    });
  });

  it('check order: 404 → 409 INVALID_TRANSITION → 400 regionCode notFound', async () => {
    const client = await platformAdmin();
    const org = await registerOrg('FARM');
    expectProblem(await patchOrg(client, UUID0, { regionCode: '00' }), 404, 'NOT_FOUND');
    expectProblem(
      await patchOrg(client, org.organizationId, { status: 'SUSPENDED', regionCode: '00' }),
      409,
      'INVALID_TRANSITION',
      { from: 'MANUAL_CHECK', to: 'SUSPENDED' },
    );
    expectErrors(await patchOrg(client, org.organizationId, { regionCode: '00' }), {
      regionCode: ['validation.notFound'],
    });
  });

  it('transitions follow entity-state-machines.json (by updateAdminOrganization); the same status is no change', async () => {
    const client = await platformAdmin();
    const allowed = new Set(
      states.organization.transitions
        .filter((t) => t.by === 'updateAdminOrganization')
        .map((t) => `${t.from}>${t.to}`),
    );
    // MANUAL_CHECK: → REJECTED allowed; → ACTIVE / SUSPENDED not (approval is approveOrganization).
    for (const to of ['ACTIVE', 'SUSPENDED'] as const) {
      const org = await registerOrg('FARM');
      expect(allowed.has(`MANUAL_CHECK>${to}`)).toBe(false);
      expectProblem(await patchOrg(client, org.organizationId, { status: to }), 409, 'INVALID_TRANSITION', {
        from: 'MANUAL_CHECK',
        to,
      });
    }
    const rejected = await registerOrg('FARM');
    expect((await patchOrg(client, rejected.organizationId, { status: 'REJECTED' })).body.status).toBe(
      'REJECTED',
    );
    const again = await patchOrg(client, rejected.organizationId, { status: 'REJECTED' });
    expect(again.status).toBe(200);
    for (const to of ['ACTIVE', 'SUSPENDED'] as const)
      expectProblem(
        await patchOrg(client, rejected.organizationId, { status: to }),
        409,
        'INVALID_TRANSITION',
        {
          from: 'REJECTED',
          to,
        },
      );
    expect(
      (await auditEntries({ action: 'updateAdminOrganization', entityId: rejected.organizationId })).length,
    ).toBe(1);

    // PLATFORM never changes its status (even to a status the machine allows from ACTIVE).
    const platform = (await listOrgs(client, { type: 'PLATFORM' })).body.items[0];
    expectProblem(await patchOrg(client, platform.id, { status: 'SUSPENDED' }), 409, 'INVALID_TRANSITION', {
      from: platform.status,
      to: 'SUSPENDED',
    });
    expect((await patchOrg(client, platform.id, { status: platform.status })).status).toBe(200);
    expect(STATUSES).toContain(platform.status);
  });

  it('SUSPENDED: sign-in and refresh → 403 ORGANIZATION_NOT_ACTIVE, gone from the directory; ACTIVE again restores', async () => {
    const client = await platformAdmin();
    const { org, client: head } = await freshHead('PROCESSOR');
    const inspector = await loginAs('INSPECTOR');
    const directory = async () =>
      (await inspector.get('/organizations', { query: { q: org.inn } })).body.items.map(
        (o: { id: string }) => o.id,
      );
    expect(await directory()).toEqual([org.organizationId]);

    const suspended = await patchOrg(client, org.organizationId, { status: 'SUSPENDED' });
    expect(suspended.body.status).toBe('SUSPENDED');
    expectProblem(await login(api(), org.email, org.password), 403, 'FORBIDDEN', {
      reason: 'ORGANIZATION_NOT_ACTIVE',
    });
    const refresh = await head.post('/auth/refresh');
    await expectContract(refresh, 'refreshToken');
    expectProblem(refresh, 403, 'FORBIDDEN', { reason: 'ORGANIZATION_NOT_ACTIVE' });
    // The access token already issued lives out its 15 minutes.
    expect((await head.get('/me')).status).toBe(200);
    expect(await directory()).toEqual([]);

    const resumed = await patchOrg(client, org.organizationId, { status: 'ACTIVE' });
    expect(resumed.body.status).toBe('ACTIVE');
    expect((await login(api(), org.email, org.password)).status).toBe(200);
    expect(await directory()).toEqual([org.organizationId]);
    const audit = await auditEntries({ action: 'updateAdminOrganization', entityId: org.organizationId });
    expect(audit.map((a) => a.diff)).toEqual([
      { status: ['ACTIVE', 'SUSPENDED'] },
      { status: ['SUSPENDED', 'ACTIVE'] },
    ]);
  });

  it('a rename drops the cached public pages of the organization’s batches (R82)', async () => {
    const client = await platformAdmin();
    // TODO(Task 6/11): the organization's batches through the API once they exist.
    const [petrov] = await query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE inn = '502701234075'`,
    );
    const codes = await query<{ code: string }>(
      `SELECT public_code AS code FROM batches WHERE origin_org_id = $1`,
      [petrov!.id],
    );
    expect(codes.length).toBeGreaterThan(0);
    const r = redis();
    for (const { code } of codes) await r.set(`pub:batch:${code}`, '{}', 'EX', 300);
    try {
      expect((await patchOrg(client, petrov!.id, { name: `${petrov!.name} ` })).status).toBe(200);
      for (const { code } of codes) expect(await r.exists(`pub:batch:${code}`), code).toBe(0);
    } finally {
      // The seeded name is restored whatever happened above.
      expect((await patchOrg(client, petrov!.id, { name: petrov!.name })).status).toBe(200);
    }
  });
});

describe('listPublicRegions', () => {
  it('without authorization: every region, by name (code points) then code', async () => {
    const res = await api().get('/public/regions');
    await expectContract(res, 'listPublicRegions');
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ code: '33', name: 'Владимирская область' });
    const keys = (res.body as { code: string; name: string }[]).map((r) => [r.name, r.code] as const);
    const sorted = [...keys].sort((a, b) => utf8Order(a[0], b[0]) || utf8Order(a[1], b[1]));
    expect(keys).toEqual(sorted);
  });
});
