/**
 * Dictionaries (contracts/openapi/paths/dictionaries.yaml, R54/D29–D30, R58, R59): reading by every role with filters
 * that are never silently ignored (R51), CRUD of the five dictionaries by ADMIN (soft delete of products, substances,
 * indicators — restore by name; hard delete of norms and regions, REFERENCE_IN_USE), CSV/XLSX import (format, header,
 * row errors, first-row-wins, numeric `unchanged`, limits, 413/415/400), product photos, audit rows.
 *
 * Every entity a test creates carries a random suffix, so the suite is re-runnable without `./at.sh reset`. Regions
 * survive a reset (the seed keeps the table), so every region a test creates is deleted again.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { closeDb, fixtureWrite, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { apiPath, fileIdOf, fixture, multipart, pngOfSize, upload, webpSize } from './lib/files.js';
import { freshHead, platformAdmin, registerOrg } from './lib/fixtures.js';
import { closeRedis, redis } from './lib/redis.js';
import { csv, IMPORT_ALLOWED, IMPORT_MAX_BYTES, workbookXml, xlsx, zip } from './lib/sheets.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const NAMES = ['products', 'substances', 'indicators', 'norms', 'regions'] as const;
type Dict = (typeof NAMES)[number];
const UUID0 = '00000000-0000-4000-8000-000000000000';
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const uniq = () => randomBytes(4).toString('hex');
/** A region code no seeded region has: `T-` + 5 upper-case hex digits (RegionCode `^[0-9A-Z-]{1,8}$`). */
const regionCode = () => `T-${randomBytes(3).toString('hex').toUpperCase().slice(0, 5)}`;

const admin = platformAdmin;

async function list(client: ApiClient, name: string, query: Record<string, string | number | boolean> = {}) {
  const res = await client.get(`/dictionaries/${name}`, { query });
  await expectContract(res, 'listDictionary');
  return res;
}

async function create(client: ApiClient, name: string, body: unknown) {
  const res = await client.post(`/dictionaries/${name}`, body);
  await expectContract(res, 'createDictionaryEntry');
  return res;
}

async function update(client: ApiClient, name: string, id: string, body: unknown) {
  const res = await client.put(`/dictionaries/${name}/${id}`, body);
  await expectContract(res, 'updateDictionaryEntry');
  return res;
}

async function remove(client: ApiClient, name: string, id: string) {
  const res = await client.delete(`/dictionaries/${name}/${id}`);
  await expectContract(res, 'deleteDictionaryEntry');
  return res;
}

async function importFile(
  client: ApiClient,
  name: string,
  data: Buffer,
  filename = 'import.csv',
  contentType = 'text/csv',
) {
  const { body, contentType: ct } = multipart([{ name: 'file', filename, contentType, data }]);
  const res = await client.post(`/dictionaries/${name}/import`, new Uint8Array(body), {
    headers: { 'content-type': ct },
  });
  await expectContract(res, 'importDictionary');
  return res;
}

async function created(client: ApiClient, name: Dict, body: Record<string, unknown>) {
  const res = await create(client, name, body);
  expect(res.status, res.text).toBe(201);
  return res.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const product = (over: Record<string, unknown> = {}) => ({
  name: `Продукт ${uniq()}`,
  category: 'GRAIN',
  lossNormPercent: '2.50',
  ...over,
});

/** The only row of `name` whose exact name/code is `key` (includeDeleted for the soft-delete dictionaries). */
async function findRow(name: Dict, key: string) {
  const res = await list(await admin(), name, {
    q: key,
    size: 100,
    ...(name !== 'norms' && name !== 'regions' && { includeDeleted: true }),
  });
  expect(res.status, res.text).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.body.items as any[]).filter((r) => (name === 'regions' ? r.code === key : r.name === key));
}

// ── roles ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('x-roles: every role reads, only ADMIN writes', () => {
  it.each(ROLES)('%s reads every dictionary (products with lossNormPercent — T9 note b)', async (role) => {
    const client = await loginAs(role, { head: false });
    for (const name of NAMES) {
      const res = await list(client, name);
      expect(res.status, `${name}: ${res.text}`).toBe(200);
      expect(res.body.items.length, name).toBeGreaterThan(0);
    }
    const products = await list(client, 'products');
    expect(products.body.items[0].lossNormPercent).toMatch(/^\d{1,3}\.\d{2}$/);
  });

  it('no token → 401', async () => {
    expectProblem(await list(api(), 'products'), 401, 'UNAUTHORIZED');
  });

  it.each(ROLES.filter((r) => r !== 'ADMIN'))(
    '%s: create/update/delete/import/photo → 403 without params',
    async (role) => {
      const client = await loginAs(role, { head: true });
      const c = await create(client, 'products', product());
      expectProblem(c, 403, 'FORBIDDEN', null);
      expectProblem(await update(client, 'products', UUID0, product()), 403, 'FORBIDDEN', null);
      expectProblem(await remove(client, 'products', UUID0), 403, 'FORBIDDEN', null);
      expectProblem(await importFile(client, 'regions', csv([['code', 'name']])), 403, 'FORBIDDEN', null);
      const photo = await upload(client, `/dictionaries/products/${UUID0}/image`, {
        data: fixture('tiny-40x20.png'),
        filename: 'p.png',
      });
      await expectContract(photo, 'uploadProductImage');
      expectProblem(photo, 403, 'FORBIDDEN', null);
    },
  );
});

// ── listDictionary ─────────────────────────────────────────────────────────────────────────────────────────────

describe('listDictionary: filters (R51), sorting, paging', () => {
  it('an unknown dictionary name → 400 errors.name', async () => {
    const client = await loginAs('FARMER');
    expectErrors(await list(client, 'animals'), { name: ['validation.enum'] });
  });

  it('filters that do not apply to the dictionary → 400 notAllowed, each reported', async () => {
    const client = await admin();
    expectErrors(await list(client, 'substances', { category: 'GRAIN' }), {
      category: ['validation.category.notAllowed'],
    });
    expectErrors(await list(client, 'products', { type: 'PESTICIDE', productId: UUID0 }), {
      type: ['validation.type.notAllowed'],
      productId: ['validation.productId.notAllowed'],
    });
    expectErrors(await list(client, 'regions', { indicatorId: UUID0 }), {
      indicatorId: ['validation.indicatorId.notAllowed'],
    });
    expectErrors(await list(client, 'norms', { includeDeleted: true }), {
      includeDeleted: ['validation.includeDeleted.notAllowed'],
    });
    expectErrors(await list(client, 'regions', { includeDeleted: false }), {
      includeDeleted: ['validation.includeDeleted.notAllowed'],
    });
  });

  it('includeDeleted is ADMIN-only; malformed values → 400', async () => {
    const farmer = await loginAs('FARMER');
    expectErrors(await list(farmer, 'products', { includeDeleted: true }), {
      includeDeleted: ['validation.includeDeleted.notAllowed'],
    });
    const client = await admin();
    expectErrors(await list(client, 'products', { category: 'WOOD' }), { category: ['validation.enum'] });
    expectErrors(await list(client, 'substances', { type: 'HERBAL' }), { type: ['validation.enum'] });
    expectErrors(await list(client, 'norms', { productId: 'x' }), { productId: ['validation.uuid'] });
    expectErrors(await list(client, 'products', { includeDeleted: 'yes' }), {
      includeDeleted: ['validation.type'],
    });
    expectErrors(await list(client, 'products', { sort: 'category,asc' }), { sort: ['validation.sort'] });
    expectErrors(await list(client, 'products', { size: 101 }), { size: ['validation.max'] });
  });

  it('products: category filter, q (substring, case-insensitive, % literal), name order by code points', async () => {
    const client = await loginAs('LAB');
    const grain = await list(client, 'products', { category: 'GRAIN', size: 100 });
    expect(grain.body.items.length).toBeGreaterThan(0);
    for (const p of grain.body.items) expect(p.category).toBe('GRAIN');
    const q = await list(client, 'products', { q: 'ПШЕНИЦА' });
    expect(q.body.items.map((p: { name: string }) => p.name)).toContain('Пшеница мягкая');
    // `\%` is two ordinary characters: LIKE would read it as a literal percent and match every name with '%'.
    expect((await list(client, 'products', { q: '\\%' })).body.total).toBe(0);

    const all = await list(client, 'products', { size: 100 });
    const names = all.body.items.map((p: { name: string }) => p.name) as string[];
    expect(names).toEqual([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    const desc = await list(client, 'products', { size: 100, sort: 'name,desc' });
    const descNames = desc.body.items.map((p: { name: string }) => p.name) as string[];
    expect(descNames).toEqual([...descNames].sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a))));
    if (all.body.total <= 100) expect(descNames).toEqual([...names].reverse());
    const page2 = await list(client, 'products', { size: 2, page: 2 });
    expect(page2.body).toMatchObject({ page: 2, size: 2, total: all.body.total });
    expect(page2.body.items.map((p: { name: string }) => p.name)).toEqual(names.slice(2, 4));
  });

  it('norms: product/indicator filters, q over product or indicator names, maxValue with six decimals', async () => {
    const client = await loginAs('INSPECTOR');
    const products = await list(client, 'products', { q: 'Пшеница мягкая' });
    const wheat = products.body.items[0];
    const norms = await list(client, 'norms', { productId: wheat.id, size: 100 });
    expect(norms.body.total).toBeGreaterThan(0);
    for (const n of norms.body.items) {
      expect(n.product).toEqual({ id: wheat.id, name: wheat.name });
      expect(n.maxValue).toMatch(/^\d{1,8}\.\d{6}$/);
    }
    // Ordered by product name, then indicator name (code points).
    const byIndicator = norms.body.items.map(
      (n: { indicator: { name: string } }) => n.indicator.name,
    ) as string[];
    expect(byIndicator).toEqual(
      [...byIndicator].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    const lead = norms.body.items.find((n: { indicator: { name: string } }) => n.indicator.name === 'Свинец');
    const byInd = await list(client, 'norms', { indicatorId: lead.indicator.id, productId: wheat.id });
    expect(byInd.body.items).toHaveLength(1);
    const q = await list(client, 'norms', { q: 'свинец', size: 100 });
    expect(q.body.total).toBeGreaterThan(1);
    for (const n of q.body.items) expect(n.indicator.name).toBe('Свинец');
  });

  it('regions: q over name or code, ordered by name', async () => {
    const client = await loginAs('RETAILER');
    const byCode = await list(client, 'regions', { q: '33' });
    expect(byCode.body.items.map((r: { code: string }) => r.code)).toContain('33');
    const byName = await list(client, 'regions', { q: 'владимирская' });
    expect(byName.body.items[0]).toMatchObject({ code: '33', name: 'Владимирская область' });
  });
});

// ── CRUD ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('products: create, update, soft delete, restore by name', () => {
  it('create → 201 (mercuryCode null by default); duplicate name → 400; audit creation diff', async () => {
    const client = await admin();
    const body = product({ lossNormPercent: '100.00' });
    const p = await created(client, 'products', body);
    expect(p).toMatchObject({ ...body, mercuryCode: null, imageUrl: null, deletedAt: null });
    const dup = await create(client, 'products', product({ name: body.name }));
    expectErrors(dup, { name: ['validation.duplicate'] });
    // Exact match only: another case is another name.
    const other = await create(client, 'products', product({ name: (body.name as string).toUpperCase() }));
    expect(other.status, other.text).toBe(201);

    const [audit] = await auditEntries({ action: 'createDictionaryEntry', entityId: p.id });
    expect(audit).toMatchObject({ entityType: 'product', backend: 'express' });
    expect(audit!.diff).toEqual({
      name: [null, body.name],
      category: [null, 'GRAIN'],
      lossNormPercent: [null, '100.00'],
    });
  });

  it('body of another dictionary, bad formats → 400 by the schema', async () => {
    const client = await admin();
    const wrong = await create(client, 'products', { name: 'Нитраты', unit: 'мг/кг' });
    expectErrors(wrong, {
      unit: ['validation.unknownField'],
      category: ['validation.required'],
      lossNormPercent: ['validation.required'],
    });
    expectErrors(await create(client, 'products', product({ lossNormPercent: '5', mercuryCode: '1.2' })), {
      lossNormPercent: ['validation.percent.format'],
      mercuryCode: ['validation.mercuryCode.format'],
    });
    expectErrors(await create(client, 'products', product({ name: '   ' })), {
      name: ['validation.pattern'],
    });
    expectErrors(await create(client, 'products', product({ name: '' })), { name: ['validation.required'] });
  });

  it('update replaces the fields (absent mercuryCode → null); 404 unknown/deleted; duplicate with any other row', async () => {
    const client = await admin();
    const a = await created(client, 'products', product({ mercuryCode: '10.51.12' }));
    const b = await created(client, 'products', product());
    const res = await update(client, 'products', a.id, {
      name: `${a.name} (изм.)`,
      category: 'DAIRY',
      lossNormPercent: '1.00',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      id: a.id,
      name: `${a.name} (изм.)`,
      category: 'DAIRY',
      mercuryCode: null,
    });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(a.updatedAt));
    const [audit] = await auditEntries({ action: 'updateDictionaryEntry', entityId: a.id });
    expect(audit!.diff).toEqual({
      name: [a.name, `${a.name} (изм.)`],
      category: ['GRAIN', 'DAIRY'],
      lossNormPercent: ['2.50', '1.00'],
      mercuryCode: ['10.51.12', null],
    });

    expectErrors(await update(client, 'products', a.id, product({ name: b.name })), {
      name: ['validation.duplicate'],
    });
    expectProblem(await update(client, 'products', UUID0, product()), 404, 'NOT_FOUND');
    expectErrors(await update(client, 'products', 'nope', product()), { id: ['validation.uuid'] });
    expect((await remove(client, 'products', b.id)).status).toBe(204);
    expectProblem(await update(client, 'products', b.id, product()), 404, 'NOT_FOUND');
    // A soft-deleted row still owns its name for updates of other rows.
    expectErrors(await update(client, 'products', a.id, product({ name: b.name })), {
      name: ['validation.duplicate'],
    });
  });

  it('soft delete: gone from lists, visible with includeDeleted; again → 404; create by the name restores it', async () => {
    const client = await admin();
    const p = await created(client, 'products', product({ mercuryCode: '10.51.11' }));
    const del = await remove(client, 'products', p.id);
    expect(del.status, del.text).toBe(204);
    expect((await list(client, 'products', { q: p.name })).body.total).toBe(0);
    const [deleted] = await findRow('products', p.name);
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expectProblem(await remove(client, 'products', p.id), 404, 'NOT_FOUND');
    const [delAudit] = await auditEntries({ action: 'deleteDictionaryEntry', entityId: p.id });
    expect(delAudit!.diff).toEqual({ deletedAt: [null, deleted.deletedAt] });

    const restored = await create(client, 'products', {
      name: p.name,
      category: 'MEAT',
      lossNormPercent: '0.00',
    });
    expect(restored.status, restored.text).toBe(201);
    expect(restored.body).toMatchObject({
      id: p.id,
      name: p.name,
      category: 'MEAT',
      lossNormPercent: '0.00',
      mercuryCode: null,
      deletedAt: null,
    });
    expect((await list(client, 'products', { q: p.name })).body.total).toBe(1);
    const [again] = await auditEntries({ action: 'createDictionaryEntry', entityId: p.id }).then((r) =>
      r.filter((x) => x.diff.deletedAt),
    );
    expect(again!.diff).toMatchObject({
      deletedAt: [deleted.deletedAt, null],
      category: ['GRAIN', 'MEAT'],
      mercuryCode: ['10.51.11', null],
    });
  });
});

describe('substances and indicators', () => {
  it('substances: create, filter by type, update, soft delete + restore', async () => {
    const client = await admin();
    const s = await created(client, 'substances', {
      name: `Препарат ${uniq()}`,
      type: 'FERTILIZER',
      waitingPeriodDays: 0,
    });
    expect(s).toMatchObject({ type: 'FERTILIZER', waitingPeriodDays: 0, deletedAt: null });
    const byType = await list(client, 'substances', { type: 'FERTILIZER', q: s.name });
    expect(byType.body.items.map((x: { id: string }) => x.id)).toEqual([s.id]);
    expect((await list(client, 'substances', { type: 'PESTICIDE', q: s.name })).body.total).toBe(0);
    expectErrors(
      await create(client, 'substances', { name: s.name, type: 'PESTICIDE', waitingPeriodDays: 3651 }),
      {
        waitingPeriodDays: ['validation.max'],
      },
    );
    expectErrors(
      await create(client, 'substances', { name: s.name, type: 'PESTICIDE', waitingPeriodDays: 1 }),
      {
        name: ['validation.duplicate'],
      },
    );
    const upd = await update(client, 'substances', s.id, {
      name: s.name,
      type: 'PESTICIDE',
      waitingPeriodDays: 45,
    });
    expect(upd.body).toMatchObject({ type: 'PESTICIDE', waitingPeriodDays: 45 });
    expect((await remove(client, 'substances', s.id)).status).toBe(204);
    const back = await create(client, 'substances', {
      name: s.name,
      type: 'PESTICIDE',
      waitingPeriodDays: 10,
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ id: s.id, waitingPeriodDays: 10, deletedAt: null });
  });

  it('indicators: create, duplicate, update, delete; audit entity type indicator', async () => {
    const client = await admin();
    const i = await created(client, 'indicators', { name: `Показатель ${uniq()}`, unit: 'мг/кг' });
    expect(i).toMatchObject({ unit: 'мг/кг', deletedAt: null });
    expectErrors(await create(client, 'indicators', { name: i.name, unit: 'Бк/кг' }), {
      name: ['validation.duplicate'],
    });
    expectErrors(await create(client, 'indicators', { name: `x${uniq()}`, unit: 'u'.repeat(25) }), {
      unit: ['validation.maxLength'],
    });
    const upd = await update(client, 'indicators', i.id, { name: i.name, unit: 'Бк/кг' });
    expect(upd.body.unit).toBe('Бк/кг');
    expect((await remove(client, 'indicators', i.id)).status).toBe(204);
    const rows = await auditEntries({ entityId: i.id });
    expect(rows.map((r) => [r.action, r.entityType])).toEqual([
      ['createDictionaryEntry', 'indicator'],
      ['updateDictionaryEntry', 'indicator'],
      ['deleteDictionaryEntry', 'indicator'],
    ]);
  });
});

describe('norms: references, pair uniqueness, hard delete', () => {
  it('create/update/delete; unknown or deleted references → 400 notFound; duplicate pair → errors.indicatorId', async () => {
    const client = await admin();
    const p = await created(client, 'products', product());
    const i1 = await created(client, 'indicators', { name: `Показатель ${uniq()}`, unit: 'мг/кг' });
    const i2 = await created(client, 'indicators', { name: `Показатель ${uniq()}`, unit: 'мг/кг' });
    const n = await created(client, 'norms', { productId: p.id, indicatorId: i1.id, maxValue: '0.5' });
    expect(n).toMatchObject({
      product: { id: p.id, name: p.name },
      indicator: { id: i1.id, name: i1.name, unit: 'мг/кг' },
      maxValue: '0.500000',
    });
    expect(n).not.toHaveProperty('deletedAt');
    expectErrors(await create(client, 'norms', { productId: p.id, indicatorId: i1.id, maxValue: '1' }), {
      indicatorId: ['validation.duplicate'],
    });
    expectErrors(await create(client, 'norms', { productId: UUID0, indicatorId: UUID0, maxValue: '1' }), {
      productId: ['validation.notFound'],
      indicatorId: ['validation.notFound'],
    });
    expectErrors(await create(client, 'norms', { productId: p.id, indicatorId: i2.id, maxValue: '1e3' }), {
      maxValue: ['validation.decimal.format'],
    });

    const upd = await update(client, 'norms', n.id, {
      productId: p.id,
      indicatorId: i2.id,
      maxValue: '12.000001',
    });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body).toMatchObject({ indicator: { id: i2.id }, maxValue: '12.000001' });
    const [audit] = await auditEntries({ action: 'updateDictionaryEntry', entityId: n.id });
    expect(audit).toMatchObject({ entityType: 'norm' });
    expect(audit!.diff).toEqual({ indicatorId: [i1.id, i2.id], maxValue: ['0.500000', '12.000001'] });

    // A soft-deleted indicator cannot be referenced any more; the norm keeps showing it.
    expect((await remove(client, 'indicators', i1.id)).status).toBe(204);
    expectErrors(
      await update(client, 'norms', n.id, { productId: p.id, indicatorId: i1.id, maxValue: '1' }),
      {
        indicatorId: ['validation.notFound'],
      },
    );
    expect((await remove(client, 'indicators', i2.id)).status).toBe(204);
    const shown = await list(client, 'norms', { productId: p.id });
    expect(shown.body.items[0]).toMatchObject({ id: n.id, indicator: { id: i2.id, name: i2.name } });

    expect((await remove(client, 'norms', n.id)).status).toBe(204);
    expect((await list(client, 'norms', { productId: p.id })).body.total).toBe(0);
    expectProblem(await remove(client, 'norms', n.id), 404, 'NOT_FOUND');
    expectProblem(
      await update(client, 'norms', n.id, { productId: p.id, indicatorId: i2.id, maxValue: '1' }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('regions: code uniqueness, hard delete, REFERENCE_IN_USE', () => {
  it('create/update/delete; duplicate code → 400 errors.code; listed publicly while it exists', async () => {
    const client = await admin();
    const code = regionCode();
    const r = await created(client, 'regions', { code, name: `Тестовый регион ${uniq()}` });
    expect(r).toEqual({ id: expect.any(String), code, name: r.name });
    expectErrors(await create(client, 'regions', { code, name: 'Другой' }), {
      code: ['validation.duplicate'],
    });
    expectErrors(await create(client, 'regions', { code: '33', name: 'Другой' }), {
      code: ['validation.duplicate'],
    });
    expectErrors(await create(client, 'regions', { code: 'ab', name: 'x' }), {
      code: ['validation.pattern'],
    });
    const code2 = regionCode();
    const upd = await update(client, 'regions', r.id, { code: code2, name: r.name });
    expect(upd.body).toEqual({ id: r.id, code: code2, name: r.name });
    expectErrors(await update(client, 'regions', r.id, { code: '33', name: r.name }), {
      code: ['validation.duplicate'],
    });
    const pub = await api().get('/public/regions');
    await expectContract(pub, 'listPublicRegions');
    expect(pub.body).toContainEqual({ code: code2, name: r.name });
    expect((await remove(client, 'regions', r.id)).status).toBe(204);
    expectProblem(await remove(client, 'regions', r.id), 404, 'NOT_FOUND');
    const [audit] = await auditEntries({ action: 'deleteDictionaryEntry', entityId: r.id });
    expect(audit).toMatchObject({
      entityType: 'region',
      diff: { code: [code2, null], name: [r.name, null] },
    });
  });

  it('a region referenced by organizations and fields → 409 REFERENCE_IN_USE {usedBy} in table order', async () => {
    const client = await admin();
    const seeded = await delRes(
      client,
      (await list(client, 'regions', { q: 'Владимирская' })).body.items[0].id,
    );
    expectProblem(seeded, 409, 'REFERENCE_IN_USE', { usedBy: ['organizations', 'fields'] });

    // Only an organization refers to the new region; once it moves away, the region can go.
    const r = await created(client, 'regions', { code: regionCode(), name: `Тестовый регион ${uniq()}` });
    const org = await registerOrg('RETAILER');
    const moved = await client.patch(`/admin/organizations/${org.organizationId}`, { regionCode: r.code });
    expect(moved.status, moved.text).toBe(200);
    expectProblem(await delRes(client, r.id), 409, 'REFERENCE_IN_USE', { usedBy: ['organizations'] });

    // A field refers to it too (FARMER in another organization).
    const { client: farmer } = await freshHead('FARM');
    const field = await farmer.post('/fields', {
      name: 'Поле в тестовом регионе',
      areaHa: '1.00',
      regionCode: r.code,
    });
    expect(field.status, field.text).toBe(201);
    expectProblem(await delRes(client, r.id), 409, 'REFERENCE_IN_USE', {
      usedBy: ['organizations', 'fields'],
    });

    // Clean up: nothing refers to the region any more, so it is deleted.
    expect(
      (await client.patch(`/admin/organizations/${org.organizationId}`, { regionCode: '33' })).status,
    ).toBe(200);
    expectProblem(await delRes(client, r.id), 409, 'REFERENCE_IN_USE', { usedBy: ['fields'] });
    const back = await farmer.put(`/fields/${field.body.id}`, {
      name: 'Поле',
      areaHa: '1.00',
      regionCode: '33',
    });
    expect(back.status, back.text).toBe(200);
    expect((await delRes(client, r.id)).status).toBe(204);
  });

  it('a soft-deleted field still refers to its region → 409 usedBy [fields]', async () => {
    const client = await admin();
    const r = await created(client, 'regions', { code: regionCode(), name: `Тестовый регион ${uniq()}` });
    const { client: farmer } = await freshHead('FARM');
    const field = await farmer.post('/fields', {
      name: 'Удаляемое поле',
      areaHa: '1.00',
      regionCode: r.code,
    });
    expect(field.status, field.text).toBe(201);
    expect((await farmer.delete(`/fields/${field.body.id}`)).status).toBe(204);
    expectProblem(await delRes(client, r.id), 409, 'REFERENCE_IN_USE', { usedBy: ['fields'] });
    // Clean-up only (regions survive `./at.sh reset`): no API removes a deleted field, so the test's own field row is
    // hard-deleted by a fixture write, then the region goes through the API.
    await fixtureWrite('DELETE FROM fields WHERE id = $1 AND deleted_at IS NOT NULL', [field.body.id]);
    expect((await delRes(client, r.id)).status).toBe(204);
  });
});

async function delRes(client: ApiClient, id: string) {
  return remove(client, 'regions', id);
}

// ── import ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('importDictionary: CSV', () => {
  it('products: BOM, CRLF, quotes; row errors in row/column order; first-row-wins; empty rows skipped but counted', async () => {
    const client = await admin();
    const u = uniq();
    const A = `Продукт "А" ${u}`;
    const B = `Продукт; Б ${u}`;
    const E = `Продукт Е ${u}`;
    const file = csv(
      [
        ['name', 'category', 'lossNormPercent'],
        [A, 'GRAIN', '5'], // 2 created, "5" is stored as 5.00
        [B, 'VEGETABLE', '2.5'], // 3 created
        [''], // 4 skipped (all cells empty), still counted
        [`Продукт В ${u}`, 'FRUIT', '101'], // 5 max
        [A, 'DAIRY', '3'], // 6 duplicate of row 2
        ['', 'GRAIN', '1'], // 7 name required
        [`Продукт Г ${u}`, 'WOOD', '1.234'], // 8 category enum, lossNormPercent pattern
        [`Продукт Д ${u}`, 'GRAIN'], // 9 wrong number of cells
        [E, 'GRAIN', 'abc'], // 10 pattern — the key still belongs to this row
        [E, 'GRAIN', '1'], // 11 duplicate of row 10
        ['   ', 'GRAIN', '1'], // 12 pattern (whitespace only)
      ],
      { eol: '\r\n', bom: true },
    );
    const res = await importFile(client, 'products', file);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 5, column: 'lossNormPercent', message: 'validation.max' },
        { row: 6, column: 'name', message: 'validation.duplicate' },
        { row: 7, column: 'name', message: 'validation.required' },
        { row: 8, column: 'category', message: 'validation.enum' },
        { row: 8, column: 'lossNormPercent', message: 'validation.pattern' },
        { row: 9, column: null, message: 'validation.import.columns' },
        { row: 10, column: 'lossNormPercent', message: 'validation.pattern' },
        { row: 11, column: 'name', message: 'validation.duplicate' },
        { row: 12, column: 'name', message: 'validation.pattern' },
      ],
    });
    const [a] = await findRow('products', A);
    expect(a).toMatchObject({
      category: 'GRAIN',
      lossNormPercent: '5.00',
      mercuryCode: null,
      deletedAt: null,
    });
    const [b] = await findRow('products', B);
    expect(b).toMatchObject({ category: 'VEGETABLE', lossNormPercent: '2.50' });
    expect(await findRow('products', E)).toEqual([]);
    const [audit] = await auditEntries({ action: 'importDictionary', entityId: a.id });
    expect(audit).toMatchObject({ entityType: 'product' });
    expect(audit!.diff).toEqual({
      name: [null, A],
      category: [null, 'GRAIN'],
      lossNormPercent: [null, '5.00'],
    });
  });

  it('products: unchanged compares numerically; updates; restores a soft-deleted row keeping its mercuryCode', async () => {
    const client = await admin();
    const u = uniq();
    const first = await importFile(
      client,
      'products',
      csv([
        ['name', 'category', 'lossNormPercent'],
        [`Импорт 1 ${u}`, 'GRAIN', '5'],
        [`Импорт 2 ${u}`, 'GRAIN', '1.5'],
      ]),
    );
    expect(first.body).toMatchObject({ created: 2, errors: [] });
    const gone = await created(
      client,
      'products',
      product({ name: `Импорт 3 ${u}`, mercuryCode: '10.51.12' }),
    );
    expect((await remove(client, 'products', gone.id)).status).toBe(204);

    const second = await importFile(
      client,
      'products',
      csv(
        [
          ['name', 'category', 'lossNormPercent'],
          [`Импорт 1 ${u}`, 'GRAIN', '5.00'], // unchanged (5 = 5.00)
          [`Импорт 2 ${u}`, 'GRAIN', '1.50'], // unchanged
          [`Импорт 2 ${u}`, 'OILSEED', '7'], // duplicate — the first row keeps the key
          [`Импорт 3 ${u}`, 'GRAIN', '2.5'], // restored → updated
          [`Импорт 4 ${u}`, 'FRUIT', '0'], // created
        ],
        { eol: '\n' },
      ),
      'import.csv',
    );
    expect(second.status, second.text).toBe(200);
    expect(second.body).toEqual({
      created: 1,
      updated: 1,
      unchanged: 2,
      errors: [{ row: 4, column: 'name', message: 'validation.duplicate' }],
    });
    const [restored] = await findRow('products', `Импорт 3 ${u}`);
    expect(restored).toMatchObject({
      id: gone.id,
      deletedAt: null,
      lossNormPercent: '2.50',
      mercuryCode: '10.51.12',
    });
    const [row] = (await auditEntries({ action: 'importDictionary', entityId: gone.id })).filter(
      (r) => r.diff.deletedAt,
    );
    expect(row!.diff.deletedAt![1]).toBeNull();
    expect(row!.diff).not.toHaveProperty('mercuryCode');
  });

  it('norms by product and indicator names: notFound, duplicate pair at the indicator column, unchanged numerically', async () => {
    const client = await admin();
    const ind = await created(client, 'indicators', { name: `Показатель ${uniq()}`, unit: 'мг/кг' });
    const gone = await created(client, 'products', product());
    expect((await remove(client, 'products', gone.id)).status).toBe(204);
    const res = await importFile(
      client,
      'norms',
      csv([
        ['product', 'indicator', 'maxValue'],
        ['Пшеница мягкая', ind.name, '0.5'],
        ['Пшеница мягкая', ind.name, '0.500000'],
        ['Нет такого продукта', ind.name, '1'],
        [gone.name, ind.name, '1'],
        ['Ячмень пивоваренный', ind.name, '1e5'],
        ['Ячмень пивоваренный', '', '1'],
      ]),
    );
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 3, column: 'indicator', message: 'validation.duplicate' },
        { row: 4, column: 'product', message: 'validation.notFound' },
        { row: 5, column: 'product', message: 'validation.notFound' },
        { row: 6, column: 'maxValue', message: 'validation.pattern' },
        { row: 7, column: 'indicator', message: 'validation.required' },
      ],
    });
    const again = await importFile(
      client,
      'norms',
      csv([
        ['product', 'indicator', 'maxValue'],
        ['Пшеница мягкая', ind.name, '0.50'],
        ['Ячмень пивоваренный', ind.name, '2'],
      ]),
    );
    expect(again.body).toEqual({ created: 1, updated: 0, unchanged: 1, errors: [] });
    const third = await importFile(
      client,
      'norms',
      csv([
        ['product', 'indicator', 'maxValue'],
        ['Ячмень пивоваренный', ind.name, '3'],
      ]),
    );
    expect(third.body).toEqual({ created: 0, updated: 1, unchanged: 0, errors: [] });
    const norms = await list(client, 'norms', { indicatorId: ind.id });
    expect(
      norms.body.items.map((n: { product: { name: string }; maxValue: string }) => [
        n.product.name,
        n.maxValue,
      ]),
    ).toEqual([
      ['Пшеница мягкая', '0.500000'],
      ['Ячмень пивоваренный', '3.000000'],
    ]);
    for (const n of norms.body.items) expect((await remove(client, 'norms', n.id)).status).toBe(204);
  });

  it('regions and substances: value rules of the import (patterns, limits), updates by key', async () => {
    const client = await admin();
    const code = regionCode();
    const res = await importFile(
      client,
      'regions',
      csv([
        ['code', 'name'],
        [code, 'Регион импорта'],
        ['bad code', 'Регион'],
        [regionCode(), 'р'.repeat(121)],
      ]),
    );
    expect(res.body).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 3, column: 'code', message: 'validation.pattern' },
        { row: 4, column: 'name', message: 'validation.maxLength' },
      ],
    });
    const renamed = await importFile(
      client,
      'regions',
      csv([
        ['code', 'name'],
        [code, 'Регион импорта 2'],
      ]),
    );
    expect(renamed.body).toEqual({ created: 0, updated: 1, unchanged: 0, errors: [] });
    const [region] = await findRow('regions', code);
    expect(region.name).toBe('Регион импорта 2');
    expect((await remove(client, 'regions', region.id)).status).toBe(204);

    const u = uniq();
    const subs = await importFile(
      client,
      'substances',
      csv([
        ['name', 'type', 'waitingPeriodDays'],
        [`Вещество ${u}`, 'PESTICIDE', '0030'],
        [`Вещество 2 ${u}`, 'PESTICIDE', '3651'],
        [`Вещество 3 ${u}`, 'PESTICIDE', '12345'],
        [`Вещество 4 ${u}`, 'HERBAL', '-1'],
      ]),
    );
    expect(subs.body).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 3, column: 'waitingPeriodDays', message: 'validation.max' },
        { row: 4, column: 'waitingPeriodDays', message: 'validation.pattern' },
        { row: 5, column: 'type', message: 'validation.enum' },
        { row: 5, column: 'waitingPeriodDays', message: 'validation.pattern' },
      ],
    });
    const [s] = await findRow('substances', `Вещество ${u}`);
    expect(s.waitingPeriodDays).toBe(30);
    const same = await importFile(
      client,
      'substances',
      csv([
        ['name', 'type', 'waitingPeriodDays'],
        [`Вещество ${u}`, 'PESTICIDE', '30'],
      ]),
    );
    expect(same.body).toEqual({ created: 0, updated: 0, unchanged: 1, errors: [] });
  });

  it('a quoted field may span lines; the report counts records, not lines', async () => {
    const client = await admin();
    const u = uniq();
    const text = `name;unit\n"Показатель\nв две строки ${u}";мг/кг\n;\n"Показатель ${u}";${'x'.repeat(25)}\n`;
    const res = await importFile(client, 'indicators', Buffer.from(text, 'utf8'));
    expect(res.body).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      errors: [{ row: 4, column: 'unit', message: 'validation.maxLength' }],
    });
    expect(await findRow('indicators', `Показатель\nв две строки ${u}`)).toHaveLength(1);
  });

  it('header must be exactly the dictionary columns → 400 errors.file [validation.import.header]', async () => {
    const client = await admin();
    for (const header of [
      ['name', 'category'],
      ['category', 'name', 'lossNormPercent'],
      ['name', 'category', 'lossNormPercent', ''],
      ['Name', 'category', 'lossNormPercent'],
    ]) {
      const res = await importFile(client, 'products', csv([header, ['x', 'GRAIN', '1']]));
      expectErrors(res, { file: ['validation.import.header'] });
    }
    expectErrors(await importFile(client, 'regions', Buffer.from([0xef, 0xbb, 0xbf])), {
      file: ['validation.import.header'],
    });
  });

  it('unclosed quote or invalid UTF-8 → 400 format; NUL byte or a ZIP that is no workbook → 415 (R58)', async () => {
    const client = await admin();
    expectErrors(await importFile(client, 'indicators', Buffer.from('name;unit\n"Свинец;мг/кг\n')), {
      file: ['validation.import.format'],
    });
    expectErrors(
      await importFile(
        client,
        'indicators',
        Buffer.concat([Buffer.from('name;unit\n'), Buffer.from([0xc3, 0x28]), Buffer.from(';x\n')]),
      ),
      { file: ['validation.import.format'] },
    );
    const nul = await importFile(client, 'indicators', Buffer.from('name;unit\nA\u0000;B\n'));
    expectProblem(nul, 415, 'UNSUPPORTED_MEDIA_TYPE', { allowed: IMPORT_ALLOWED });
    const notBook = zip([
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: '[Content_Types].xml', data: '<Types/>' },
    ]);
    const z = await importFile(client, 'indicators', notBook, 'import.xlsx');
    expectProblem(z, 415, 'UNSUPPORTED_MEDIA_TYPE', { allowed: IMPORT_ALLOWED });
    const broken = Buffer.concat([Buffer.from('PK\u0003\u0004'), randomBytes(200)]);
    expectProblem(
      await importFile(client, 'indicators', broken, 'import.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('10 000 data rows are processed, 10 001 → 400 tooManyRows (empty rows do not count)', async () => {
    const client = await admin();
    const rows = (n: number) => [['code', 'name'], ...Array.from({ length: n }, (_, i) => [`bad-${i}`, 'x'])];
    const exactly = csv([...rows(10_000), [''], ['']]);
    const ok = await importFile(client, 'regions', exactly);
    expect(ok.status, ok.text.slice(0, 300)).toBe(200);
    expect(ok.body).toMatchObject({ created: 0, updated: 0, unchanged: 0 });
    expect(ok.body.errors).toHaveLength(10_000);
    expect(ok.body.errors[9_999]).toEqual({ row: 10_001, column: 'code', message: 'validation.pattern' });
    expectErrors(await importFile(client, 'regions', csv(rows(10_001))), {
      file: ['validation.import.tooManyRows'],
    });
  });

  it('the file limit is inclusive: exactly 5 MiB → 200, one byte more → 413 {maxBytes}; form errors → 400', async () => {
    const client = await admin();
    const head = Buffer.from('name;unit\n');
    const pad = (total: number) =>
      Buffer.concat([head, Buffer.from('x'.repeat(total - head.length - 3)), Buffer.from(';u\n')]);
    const ok = await importFile(client, 'indicators', pad(IMPORT_MAX_BYTES));
    expect(ok.status, ok.text.slice(0, 300)).toBe(200);
    expect(ok.body.errors).toEqual([{ row: 2, column: 'name', message: 'validation.maxLength' }]);
    const big = await importFile(client, 'indicators', pad(IMPORT_MAX_BYTES + 1));
    expectProblem(big, 413, 'FILE_TOO_LARGE', { maxBytes: IMPORT_MAX_BYTES });

    const empty = await importFile(client, 'indicators', Buffer.alloc(0));
    expectErrors(empty, { file: ['validation.required'] });
    const json = await client.post('/dictionaries/indicators/import', { file: 'x' });
    await expectContract(json, 'importDictionary');
    expectErrors(json, { file: ['validation.required'] });
    expectErrors(await importFile(client, 'things', csv([['a']])), { name: ['validation.enum'] });
  });
});

describe('importDictionary: XLSX', () => {
  it('the first sheet: strings as is, numbers in shortest form, other cell types → pattern; sheet row numbers', async () => {
    const client = await admin();
    const u = uniq();
    const book = await xlsx([
      {
        name: 'Препараты',
        rows: [
          ['name', 'type', 'waitingPeriodDays'],
          [`Вещество A ${u}`, 'PESTICIDE', 30], // numeric 30 → "30"
          [`Вещество B ${u}`, 'FERTILIZER', '0'], // string
          [`Вещество C ${u}`, 'PESTICIDE', new Date(Date.UTC(2026, 0, 2))], // date → pattern
          [`Вещество D ${u}`, 'PESTICIDE', true], // boolean → pattern
          [`Вещество E ${u}`, 'PESTICIDE', 3651], // max
          [`Вещество F ${u}`, 'PESTICIDE', 1.5], // "1.5" → pattern
          null, // row 8 not stored
          [null, 'PESTICIDE', 7], // row 9: name required
          [`Вещество G ${u}`, 'PESTICIDE', 7, 'лишняя'], // row 10: more cells than the header
          [`Вещество H ${u}`, 'PESTICIDE', { error: '#N/A' }], // error cell → pattern
          [`Вещество I ${u}`, 'PESTICIDE'], // row 12: fewer cells — a sheet does not store empty cells
        ],
      },
      {
        name: 'Второй',
        rows: [
          ['name', 'type', 'waitingPeriodDays'],
          [`Не импортируется ${u}`, 'PESTICIDE', 1],
        ],
      },
    ]);
    const res = await importFile(client, 'substances', book, 'substances.xlsx', 'application/octet-stream');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 4, column: 'waitingPeriodDays', message: 'validation.pattern' },
        { row: 5, column: 'waitingPeriodDays', message: 'validation.pattern' },
        { row: 6, column: 'waitingPeriodDays', message: 'validation.max' },
        { row: 7, column: 'waitingPeriodDays', message: 'validation.pattern' },
        { row: 9, column: 'name', message: 'validation.required' },
        { row: 10, column: null, message: 'validation.import.columns' },
        { row: 11, column: 'waitingPeriodDays', message: 'validation.pattern' },
        { row: 12, column: 'waitingPeriodDays', message: 'validation.required' },
      ],
    });
    const [a] = await findRow('substances', `Вещество A ${u}`);
    expect(a.waitingPeriodDays).toBe(30);
    expect(await findRow('substances', `Не импортируется ${u}`)).toEqual([]);
  });

  it('numeric cells: 2 → "2", 0.1 → "0.1", no exponent; wrong header → 400', async () => {
    const client = await admin();
    const u = uniq();
    const book = await xlsx([
      {
        name: 'Лист1',
        rows: [
          ['name', 'category', 'lossNormPercent'],
          [`XLSX 1 ${u}`, 'GRAIN', 2],
          [`XLSX 2 ${u}`, 'GRAIN', 0.1],
          [`XLSX 3 ${u}`, 'GRAIN', 0.0000001],
        ],
      },
    ]);
    const res = await importFile(client, 'products', book, 'p.xlsx');
    expect(res.body).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      errors: [{ row: 4, column: 'lossNormPercent', message: 'validation.pattern' }],
    });
    expect((await findRow('products', `XLSX 1 ${u}`))[0].lossNormPercent).toBe('2.00');
    expect((await findRow('products', `XLSX 2 ${u}`))[0].lossNormPercent).toBe('0.10');

    const bad = await xlsx([{ name: 'Лист1', rows: [['code', 'name', 'extra']] }]);
    expectErrors(await importFile(client, 'regions', bad, 'r.xlsx'), { file: ['validation.import.header'] });
    const noHeader = await xlsx([{ name: 'Лист1', rows: [null, ['code', 'name']] }]);
    expectErrors(await importFile(client, 'regions', noHeader, 'r.xlsx'), {
      file: ['validation.import.header'],
    });
  });

  it('P23/P24 limits (the rest are backend unit tests): 65 <c> in a row, a cell in column 65, an unread bomb → 415', async () => {
    const client = await admin();
    const tooLarge = { allowed: IMPORT_ALLOWED, reason: 'workbook-too-large' };
    const col = (n: number) => {
      let s = '';
      for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
    };
    const header =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>';
    // Cells are `<c>` elements: styled empty ones count (2 valued + 63 styled = 65).
    const styled = `${header}<row r="2"><c r="A2" t="inlineStr"><is><t>R1</t></is></c><c r="B2" t="inlineStr"><is><t>n</t></is></c>${Array.from({ length: 63 }, (_, i) => `<c r="${col(i + 3)}2" s="1"/>`).join('')}</row>`;
    expectProblem(
      await importFile(client, 'regions', workbookXml(styled), 's.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      tooLarge,
    );
    // A single cell, but in column 65 (BM).
    const far = `${header}<row r="2"><c r="BM2"><v>1</v></c></row>`;
    expectProblem(
      await importFile(client, 'regions', workbookXml(far), 'f.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      tooLarge,
    );
    // A bomb in an entry the import never reads: 64 MiB of zeros declared as 10 bytes.
    const bomb = workbookXml(header, [
      { name: 'x/bomb.bin', data: Buffer.alloc(64 * 1024 * 1024), declared: 10 },
    ]);
    expectProblem(
      await importFile(client, 'regions', bomb, 'b.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      tooLarge,
    );
    // 64 cells (up to column BL) are fine: here only a header, so nothing is imported.
    const ok = await importFile(client, 'regions', workbookXml(header), 'o.xlsx');
    expect(ok.body).toEqual({ created: 0, updated: 0, unchanged: 0, errors: [] });
    const wide = await xlsx([
      { name: 'Лист1', rows: [['code', 'name'], Array.from({ length: 65 }, () => 'x')] },
    ]);
    expectProblem(await importFile(client, 'regions', wide, 'w.xlsx'), 415, 'UNSUPPORTED_MEDIA_TYPE', {
      allowed: IMPORT_ALLOWED,
      reason: 'workbook-too-large',
    });
  });

  it('P25 structure: missing `r`, prefixed SpreadsheetML elements, a bad CRC → 415 {allowed}', async () => {
    const client = await admin();
    const refused = { allowed: IMPORT_ALLOWED };
    const noR = workbookXml('<row><c r="A1"><v>1</v></c></row>');
    expectProblem(await importFile(client, 'regions', noR, 'r.xlsx'), 415, 'UNSUPPORTED_MEDIA_TYPE', refused);
    const noCellR = workbookXml('<row r="1"><c><v>1</v></c></row>');
    expectProblem(
      await importFile(client, 'regions', noCellR, 'c.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      refused,
    );
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const prefixed = workbookXml('', [], {
      sheet: `<x:worksheet xmlns:x="${ns}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    });
    expectProblem(
      await importFile(client, 'regions', prefixed, 'p.xlsx'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      refused,
    );
    const header =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>';
    const crc = workbookXml(header, [], { badSheetCrc: true });
    expectProblem(await importFile(client, 'regions', crc, 'k.xlsx'), 415, 'UNSUPPORTED_MEDIA_TYPE', refused);
  });

  it('P25/P26: the 1 000-character cap — regions.code of 1 000 characters → pattern, of 1 001 → maxLength', async () => {
    // `code` has no length limit of its own in the import rules (only its pattern), so the cap alone decides.
    const client = await admin();
    const book = await xlsx([
      {
        name: 'Лист1',
        rows: [
          ['code', 'name'],
          ['A'.repeat(1000), 'Регион'],
          ['A'.repeat(1001), 'Регион'],
        ],
      },
    ]);
    const res = await importFile(client, 'regions', book, 'l.xlsx');
    expect(res.body).toEqual({
      created: 0,
      updated: 0,
      unchanged: 0,
      errors: [
        { row: 2, column: 'code', message: 'validation.pattern' },
        { row: 3, column: 'code', message: 'validation.maxLength' },
      ],
    });
  });

  it('P26: `r` semantics — every class of bad row or cell reference → 415 {allowed}', async () => {
    const client = await admin();
    const header =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>';
    const c = (ref: string) => `<c r="${ref}"><v>1</v></c>`;
    const cases: Record<string, string> = {
      zeroRow: '<row r="0"><c r="A0"><v>1</v></c></row>',
      hugeRow: '<row r="99999999999"><c r="A99999999999"><v>1</v></c></row>',
      fractionRow: '<row r="2.5"><c r="A2"><v>1</v></c></row>',
      lettersRow: '<row r="3abc"><c r="A3"><v>1</v></c></row>',
      duplicateRows: `${header}<row r="2">${c('A2')}</row><row r="2">${c('A2')}</row>`,
      rowsOutOfOrder: `${header}<row r="3">${c('A3')}</row><row r="2">${c('A2')}</row>`,
      secondHeader: `${header}<row r="2">${c('A2')}</row>${header}`,
      cellOfAnotherRow: `${header}<row r="2">${c('A7')}</row>`,
      cellWithoutRow: `${header}<row r="2">${c('A')}</row>`,
      decreasingCells: `${header}<row r="2">${c('B2')}${c('A2')}</row>`,
      duplicateCells: `${header}<row r="2">${c('A2')}${c('A2')}</row>`,
      lowerCase: `${header}<row r="2">${c('a2')}</row>`,
      dollar: `${header}<row r="2">${c('$A$2')}</row>`,
      // Malformed wins over the column limit on one element.
      dollarBeyondBL: `${header}<row r="2">${c('$BM2')}</row>`,
    };
    for (const [name, rows] of Object.entries(cases)) {
      const res = await importFile(client, 'regions', workbookXml(rows), `${name}.xlsx`);
      expect(res.status, `${name}: ${res.text}`).toBe(415);
      expect(res.body.params, name).toEqual({ allowed: IMPORT_ALLOWED });
    }
  });

  it('P26: namespaces — none, Strict OOXML, a foreign default namespace inside → 415 {allowed}', async () => {
    const client = await admin();
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const header =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>';
    const sheets = {
      none: `<worksheet><sheetData>${header}</sheetData></worksheet>`,
      strict: `<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"><sheetData>${header}</sheetData></worksheet>`,
      foreignInside: `<worksheet xmlns="${ns}"><sheetData><row r="1" xmlns="urn:evil"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
    };
    for (const [name, sheet] of Object.entries(sheets)) {
      const res = await importFile(client, 'regions', workbookXml('', [], { sheet }), `${name}.xlsx`);
      expect(res.status, `${name}: ${res.text}`).toBe(415);
      expect(res.body.params, name).toEqual({ allowed: IMPORT_ALLOWED });
    }
  });

  it('P25: Cyrillic across a 64 KiB boundary reads back exactly, for every byte parity of the boundary', async () => {
    // Four imports of the same 250 names from a hand-made workbook whose shared strings (> 64 KiB, almost all 2-byte
    // characters) are shifted by 0, 1, 40 and 41 bytes of padding in the workbook part: whatever the reader's
    // chunking, one of the imports puts the 64 KiB offset inside a 2-byte character. The first import creates the
    // products; each later one must find every name unchanged — a single cut character would create a new product.
    const client = await admin();
    const u = uniq();
    const names = Array.from({ length: 250 }, (_, i) => `Ёж ${u} ${i} ${'ЖЩЫЮЯ'.repeat(28)}`);
    const header = `<row r="1">${['name', 'category', 'lossNormPercent']
      .map((h, k) => `<c r="${'ABC'[k]}1" t="inlineStr"><is><t>${h}</t></is></c>`)
      .join('')}</row>`;
    const rows = names
      .map(
        (_, i) =>
          `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>${i}</v></c><c r="B${i + 2}" t="inlineStr"><is><t>GRAIN</t></is></c><c r="C${i + 2}"><v>1.5</v></c></row>`,
      )
      .join('');
    const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${names
      .map((n) => `<si><t>${n}</t></si>`)
      .join('')}</sst>`;
    expect(Buffer.byteLength(sst)).toBeGreaterThan(70 * 1024); // the shared strings span the 64 KiB offset
    const reports = [];
    for (const pad of [0, 1, 40, 41]) {
      const book = workbookXml(header + rows, [], { sst, workbookPad: pad });
      const res = await importFile(client, 'products', book, `cyr${pad}.xlsx`);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      reports.push(res.body);
    }
    expect(reports).toEqual([
      { created: 250, updated: 0, unchanged: 0, errors: [] },
      { created: 0, updated: 0, unchanged: 250, errors: [] },
      { created: 0, updated: 0, unchanged: 250, errors: [] },
      { created: 0, updated: 0, unchanged: 250, errors: [] },
    ]);
    const found: string[] = [];
    for (let page = 1; page <= 3; page++)
      found.push(
        ...(await list(client, 'products', { q: `Ёж ${u} `, size: 100, page })).body.items.map(
          (p: { name: string }) => p.name,
        ),
      );
    expect(found.sort()).toEqual([...names].sort());
  });
});

// ── product photos ─────────────────────────────────────────────────────────────────────────────────────────────

describe('uploadProductImage', () => {
  it('stores WebP variants served publicly; replaces the previous photo; audit rows', async () => {
    const client = await admin();
    const p = await created(client, 'products', product());
    const first = await upload(client, `/dictionaries/products/${p.id}/image`, {
      data: fixture('landscape-640x320.png'),
      filename: 'photo.png',
    });
    await expectContract(first, 'uploadProductImage');
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({
      id: p.id,
      name: p.name,
      imageUrl: expect.stringMatching(/^\/api\/v1\/public\/files\//),
    });
    const pub = await api().get(apiPath(first.body.imageUrl), { query: { variant: 96 } });
    await expectContract(pub, 'downloadPublicFile');
    expect(webpSize(pub.bytes)).toEqual({ width: 96, height: 48 });
    const listed = await list(await loginAs('RETAILER'), 'products', { q: p.name });
    expect(listed.body.items[0].imageUrl).toBe(first.body.imageUrl);

    const second = await upload(client, `/dictionaries/products/${p.id}/image`, {
      data: fixture('portrait-300x600.jpg'),
      filename: 'photo.jpg',
    });
    expect(second.status, second.text).toBe(200);
    expect(second.body.imageUrl).not.toBe(first.body.imageUrl);
    const old = await api().get(apiPath(first.body.imageUrl));
    await expectContract(old, 'downloadPublicFile');
    expectProblem(old, 404, 'NOT_FOUND');

    const rows = await auditEntries({
      action: 'uploadProductImage',
      actorId: (await client.get('/me')).body.id,
    });
    const mine = rows.filter((r) => r.entityId === p.id);
    expect(mine.map((r) => r.diff)).toEqual([
      { imageFileId: [null, fileIdOf(first.body.imageUrl)] },
      { imageFileId: [fileIdOf(first.body.imageUrl), fileIdOf(second.body.imageUrl)] },
    ]);
    const deletion = await auditEntries({
      action: 'uploadProductImage',
      entityId: fileIdOf(first.body.imageUrl),
    });
    expect(deletion.map((r) => r.entityType)).toEqual(['file', 'file']);
    expect(deletion[1]!.diff.deletedAt![0]).toBeNull();
  });

  it('404 unknown or deleted product (after 413, before 415); SVG/PDF → 415; limit inclusive', async () => {
    const client = await admin();
    const put = (id: string, data: Buffer, filename = 'x.png') =>
      upload(client, `/dictionaries/products/${id}/image`, { data, filename }).then(async (r) => {
        await expectContract(r, 'uploadProductImage');
        return r;
      });
    const p = await created(client, 'products', product());
    expectProblem(await put(UUID0, fixture('tiny-40x20.png')), 404, 'NOT_FOUND');
    expectProblem(await put(UUID0, fixture('logo-clean.svg')), 404, 'NOT_FOUND');
    expectProblem(await put(UUID0, pngOfSize(IMAGE_MAX_BYTES + 1)), 413, 'FILE_TOO_LARGE', {
      maxBytes: IMAGE_MAX_BYTES,
    });
    const svg = await put(p.id, fixture('logo-clean.svg'), 'x.svg');
    expectProblem(svg, 415, 'UNSUPPORTED_MEDIA_TYPE', { allowed: ['image/jpeg', 'image/png', 'image/webp'] });
    expectProblem(await put(p.id, fixture('document.pdf'), 'x.pdf'), 415, 'UNSUPPORTED_MEDIA_TYPE');
    const exact = await put(p.id, pngOfSize(IMAGE_MAX_BYTES));
    expect(exact.status, exact.text).toBe(200);
    expect((await remove(client, 'products', p.id)).status).toBe(204);
    expectProblem(await put(p.id, fixture('tiny-40x20.png')), 404, 'NOT_FOUND');
    expectErrors(await put('nope', fixture('tiny-40x20.png')), { id: ['validation.uuid'] });
  });
});

describe('product changes and the public batch cache (R82 `pub:batch:*`)', () => {
  it('a rename or a new photo drops the cached pages of the product’s batches; others stay', async () => {
    const client = await admin();
    const [wheat] = await findRow('products', 'Пшеница мягкая');
    // TODO(Task 6): the product's batches through the batches API once it exists.
    const mine = await query<{ code: string }>(
      `SELECT public_code AS code FROM batches WHERE product_id = $1`,
      [wheat.id],
    );
    const [other] = await query<{ code: string }>(
      `SELECT public_code AS code FROM batches WHERE product_id <> $1 LIMIT 1`,
      [wheat.id],
    );
    expect(mine.length).toBeGreaterThan(0);
    const r = redis();
    const fill = async () => {
      for (const { code } of [...mine, other!]) await r.set(`pub:batch:${code}`, '{}', 'EX', 300);
    };
    const body = {
      name: wheat.name,
      category: wheat.category,
      lossNormPercent: wheat.lossNormPercent,
      mercuryCode: wheat.mercuryCode,
    };

    await fill();
    try {
      const renamed = await update(client, 'products', wheat.id, { ...body, name: `${wheat.name} ` });
      expect(renamed.status).toBe(200);
      for (const { code } of mine) expect(await r.exists(`pub:batch:${code}`), code).toBe(0);
      expect(await r.exists(`pub:batch:${other!.code}`)).toBe(1);
    } finally {
      // The seeded name is restored whatever happened above.
      expect((await update(client, 'products', wheat.id, body)).status).toBe(200);
    }

    // Only seeded products have batches until the batches API exists (Task 6), so the photo test replaces the
    // seeded wheat photo; `./at.sh reset` restores it (the previous photo cannot be re-attached through the API).
    await fill();
    const photo = await upload(client, `/dictionaries/products/${wheat.id}/image`, {
      data: fixture('landscape-640x320.png'),
      filename: 'wheat.png',
    });
    expect(photo.status, photo.text).toBe(200);
    for (const { code } of mine) expect(await r.exists(`pub:batch:${code}`), code).toBe(0);
    expect(await r.exists(`pub:batch:${other!.code}`)).toBe(1);
    await r.del(`pub:batch:${other!.code}`);
  });
});
