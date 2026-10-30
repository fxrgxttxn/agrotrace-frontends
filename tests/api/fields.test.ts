/**
 * Fields and treatments (contracts/openapi/paths/fields.yaml, treatments.yaml; FR-PROD-01/02, R41/D1, R51): x-roles,
 * visibility (FARMER — the own farm's fields, INSPECTOR and ADMIN — all, read-only; invisible → 404), GeoJSON Polygon
 * validation, the 24-hour treatment edit window (inclusive, `canEditTreatment`; 403 EDIT_WINDOW_CLOSED), `from`/`to`
 * as UTC dates, the role-restricted `organizationId` filter, audit rows.
 *
 * The edit window cannot be waited for: a treatment's `created_at` is moved back by a fixture write (lib/db.ts), the
 * documented escape for clocks a test cannot wait for.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { closeDb, fixtureWrite } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { freshEmployee, freshHead } from './lib/fixtures.js';
import { closeRedis } from './lib/redis.js';
import { instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const UUID0 = '00000000-0000-4000-8000-000000000000';
const DAY_MS = 24 * 3600 * 1000;

const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [40.1, 56.1],
      [40.2, 56.1],
      [40.2, 56.2],
      [40.1, 56.2],
      [40.1, 56.1],
    ],
  ],
};

const fieldBody = (over: Record<string, unknown> = {}) => ({
  name: 'Опытный участок',
  areaHa: '12.50',
  regionCode: '33',
  geometry: SQUARE,
  ...over,
});

async function listFields(client: ApiClient, query: Record<string, string | number> = {}) {
  const res = await client.get('/fields', { query });
  await expectContract(res, 'listFields');
  return res;
}
async function createField(client: ApiClient, body: unknown) {
  const res = await client.post('/fields', body);
  await expectContract(res, 'createField');
  return res;
}
async function getField(client: ApiClient, id: string) {
  const res = await client.get(`/fields/${id}`);
  await expectContract(res, 'getField');
  return res;
}
async function updateField(client: ApiClient, id: string, body: unknown) {
  const res = await client.put(`/fields/${id}`, body);
  await expectContract(res, 'updateField');
  return res;
}
async function deleteField(client: ApiClient, id: string) {
  const res = await client.delete(`/fields/${id}`);
  await expectContract(res, 'deleteField');
  return res;
}
async function listTreatments(
  client: ApiClient,
  fieldId: string,
  query: Record<string, string | number> = {},
) {
  const res = await client.get(`/fields/${fieldId}/treatments`, { query });
  await expectContract(res, 'listFieldTreatments');
  return res;
}
async function createTreatment(client: ApiClient, fieldId: string, body: unknown) {
  const res = await client.post(`/fields/${fieldId}/treatments`, body);
  await expectContract(res, 'createTreatment');
  return res;
}
async function updateTreatment(client: ApiClient, id: string, body: unknown) {
  const res = await client.put(`/treatments/${id}`, body);
  await expectContract(res, 'updateTreatment');
  return res;
}

let substanceCache: Promise<{ id: string; name: string; type: string; waitingPeriodDays: number }[]> | null =
  null;
/** Seeded substances (listDictionary). */
function substances() {
  substanceCache ??= (async () => {
    const client = await loginAs('FARMER');
    const res = await client.get('/dictionaries/substances', { query: { size: 100 } });
    await expectContract(res, 'listDictionary');
    return res.body.items;
  })();
  return substanceCache;
}

const treatmentBody = async (over: Record<string, unknown> = {}) => ({
  substanceId: (await substances())[0]!.id,
  dose: '1.500',
  doseUnit: 'л/га',
  appliedAt: '2026-06-02T07:00:00Z',
  ...over,
});

/** A fresh farm (head client) with one field. */
async function farmWithField(body: Record<string, unknown> = {}) {
  const farm = await freshHead('FARM');
  const res = await createField(farm.client, fieldBody(body));
  expect(res.status, res.text).toBe(201);
  return { ...farm, field: res.body as { id: string; name: string } };
}

describe('x-roles', () => {
  it.each(ROLES.filter((r) => !['FARMER', 'INSPECTOR', 'ADMIN'].includes(r)))(
    '%s → 403 without params on every operation',
    async (role) => {
      const client = await loginAs(role, { head: true });
      expectProblem(await listFields(client), 403, 'FORBIDDEN', null);
      expectProblem(await createField(client, fieldBody()), 403, 'FORBIDDEN', null);
      expectProblem(await getField(client, UUID0), 403, 'FORBIDDEN', null);
      expectProblem(await updateField(client, UUID0, fieldBody()), 403, 'FORBIDDEN', null);
      expectProblem(await deleteField(client, UUID0), 403, 'FORBIDDEN', null);
      expectProblem(await listTreatments(client, UUID0), 403, 'FORBIDDEN', null);
      expectProblem(await createTreatment(client, UUID0, await treatmentBody()), 403, 'FORBIDDEN', null);
      expectProblem(await updateTreatment(client, UUID0, await treatmentBody()), 403, 'FORBIDDEN', null);
    },
  );

  it.each(['INSPECTOR', 'ADMIN'] as const)('%s reads but never writes → 403 on writes', async (role) => {
    const client = await loginAs(role);
    expect((await listFields(client)).status).toBe(200);
    expectProblem(await createField(client, fieldBody()), 403, 'FORBIDDEN', null);
    expectProblem(await updateField(client, UUID0, fieldBody()), 403, 'FORBIDDEN', null);
    expectProblem(await deleteField(client, UUID0), 403, 'FORBIDDEN', null);
    expectProblem(await createTreatment(client, UUID0, await treatmentBody()), 403, 'FORBIDDEN', null);
    expectProblem(await updateTreatment(client, UUID0, await treatmentBody()), 403, 'FORBIDDEN', null);
  });

  it('no token → 401', async () => {
    expectProblem(await listFields(api()), 401, 'UNAUTHORIZED');
  });
});

describe('visibility', () => {
  it('FARMER sees the own farm only (employees too); a foreign field is 404 for every operation', async () => {
    const { client, org, field } = await farmWithField({ name: 'Своё поле' });
    const employee = await freshEmployee(client, 'FARM');
    const own = await listFields(employee.client, { size: 100 });
    expect(own.body.items.map((f: { id: string }) => f.id)).toEqual([field.id]);
    expect(own.body.items[0].organization).toMatchObject({ id: org.organizationId, type: 'FARM' });

    const zarya = await loginAs('FARMER', { key: 'zarya.head' });
    const theirs = await listFields(zarya, { size: 100 });
    expect(theirs.body.total).toBeGreaterThan(0);
    expect(theirs.body.items.map((f: { id: string }) => f.id)).not.toContain(field.id);
    expectProblem(await getField(zarya, field.id), 404, 'NOT_FOUND');
    expectProblem(await updateField(zarya, field.id, fieldBody()), 404, 'NOT_FOUND');
    expectProblem(await deleteField(zarya, field.id), 404, 'NOT_FOUND');
    expectProblem(await listTreatments(zarya, field.id), 404, 'NOT_FOUND');
    expectProblem(await createTreatment(zarya, field.id, await treatmentBody()), 404, 'NOT_FOUND');
  });

  it('INSPECTOR and ADMIN see every farm; organizationId filters for them; FARMER with it → 400 notAllowed (R51)', async () => {
    const { org, field } = await farmWithField();
    for (const role of ['INSPECTOR', 'ADMIN'] as const) {
      const client = await loginAs(role);
      const all = await listFields(client, { size: 100 });
      const orgs = new Set(all.body.items.map((f: { organization: { id: string } }) => f.organization.id));
      expect(orgs.size).toBeGreaterThan(1);
      const one = await listFields(client, { organizationId: org.organizationId });
      expect(one.body.items.map((f: { id: string }) => f.id)).toEqual([field.id]);
      expect((await getField(client, field.id)).status).toBe(200);
      expect((await listTreatments(client, field.id)).status).toBe(200);
    }
    const farmer = await loginAs('FARMER');
    expectErrors(await listFields(farmer, { organizationId: org.organizationId }), {
      organizationId: ['validation.organizationId.notAllowed'],
    });
  });
});

describe('createField / getField / updateField / deleteField', () => {
  it('create → 201 with region, geometry as sent, no treatments; audit creation diff', async () => {
    const { client, user, org } = await freshHead('FARM');
    const res = await createField(client, fieldBody({ name: '  Поле с пробелами  ' }));
    expect(res.status, res.text).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: '  Поле с пробелами  ',
      areaHa: '12.50',
      region: { code: '33', name: 'Владимирская область' },
      geometry: SQUARE,
      lastTreatmentAt: null,
      treatmentsCount: 0,
      organization: { id: org.organizationId, name: expect.any(String), type: 'FARM', logoUrl: null },
    });
    expect(instants((await getField(client, res.body.id)).body)).toEqual(instants(res.body));
    const noGeometry = await createField(client, { name: 'Без контура', areaHa: '0.01', regionCode: '50' });
    expect(noGeometry.status).toBe(201);
    expect(noGeometry.body.geometry).toBeNull();

    const [audit] = await auditEntries({ action: 'createField', entityId: res.body.id });
    expect(audit).toMatchObject({ entityType: 'field', actor: { id: user.id } });
    expect(audit!.diff).toEqual({
      name: [null, '  Поле с пробелами  '],
      areaHa: [null, '12.50'],
      regionCode: [null, '33'],
      geometry: [null, SQUARE],
      organizationId: [null, org.organizationId],
    });
  });

  it('GeoJSON validation: ring closure → errors.geometry; too few positions, ranges, type → 400', async () => {
    const { client } = await freshHead('FARM');
    const open = structuredClone(SQUARE);
    open.coordinates[0]![4] = [40.1, 56.15];
    expectErrors(await createField(client, fieldBody({ geometry: open })), {
      geometry: ['validation.geometry.ringNotClosed'],
    });
    const short = {
      type: 'Polygon',
      coordinates: [
        [
          [40.1, 56.1],
          [40.2, 56.1],
          [40.1, 56.1],
        ],
      ],
    };
    const r1 = await createField(client, fieldBody({ geometry: short }));
    expect(r1.status).toBe(400);
    expect(Object.keys(r1.body.errors).every((k) => k.startsWith('geometry'))).toBe(true);
    const far = structuredClone(SQUARE);
    far.coordinates[0]![1] = [181, 56.1];
    far.coordinates[0]![2] = [40.2, -91];
    const r2 = await createField(client, fieldBody({ geometry: far }));
    expect(r2.status).toBe(400);
    expect(Object.keys(r2.body.errors).every((k) => k.startsWith('geometry'))).toBe(true);
    const point = await createField(
      client,
      fieldBody({ geometry: { type: 'Point', coordinates: [40, 56] } }),
    );
    expect(point.status).toBe(400);
    const empty = await createField(client, fieldBody({ geometry: { type: 'Polygon', coordinates: [[]] } }));
    expect(empty.status, empty.text).toBe(400);
    const noRings = await createField(client, fieldBody({ geometry: { type: 'Polygon', coordinates: [] } }));
    expect(noRings.status, noRings.text).toBe(400);
  });

  it('body errors: area, blank name, unknown field; unknown region → notFound (after the schema)', async () => {
    const { client } = await freshHead('FARM');
    expectErrors(await createField(client, fieldBody({ areaHa: '0.00', name: ' ', extra: 1 })), {
      areaHa: ['validation.areaHa.format'],
      name: ['validation.pattern'],
      extra: ['validation.unknownField'],
    });
    expectErrors(await createField(client, fieldBody({ areaHa: '12.5' })), {
      areaHa: ['validation.areaHa.format'],
    });
    expectErrors(await createField(client, fieldBody({ regionCode: '00' })), {
      regionCode: ['validation.notFound'],
    });
  });

  it('update is a full replacement (absent geometry → null); last write wins; audit diff of changes', async () => {
    const { client, field } = await farmWithField();
    const res = await updateField(client, field.id, {
      name: 'Переименовано',
      areaHa: '99.99',
      regionCode: '50',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      id: field.id,
      name: 'Переименовано',
      areaHa: '99.99',
      region: { code: '50' },
      geometry: null,
    });
    const [audit] = await auditEntries({ action: 'updateField', entityId: field.id });
    expect(audit!.diff).toEqual({
      name: ['Опытный участок', 'Переименовано'],
      areaHa: ['12.50', '99.99'],
      regionCode: ['33', '50'],
      geometry: [SQUARE, null],
    });
    // The same values again: no change — no audit row (AuditEntry, P23).
    const same = await updateField(client, field.id, {
      name: 'Переименовано',
      areaHa: '99.99',
      regionCode: '50',
    });
    expect(same.status, same.text).toBe(200);
    expect(await auditEntries({ action: 'updateField', entityId: field.id })).toHaveLength(1);
    // Geometry compares by content, whatever the key order of the body.
    const withShape = await updateField(client, field.id, fieldBody());
    expect(withShape.status).toBe(200);
    const reordered = { coordinates: SQUARE.coordinates, type: 'Polygon' };
    expect((await updateField(client, field.id, fieldBody({ geometry: reordered }))).status).toBe(200);
    expect(await auditEntries({ action: 'updateField', entityId: field.id })).toHaveLength(2);
    expectErrors(await updateField(client, field.id, { name: 'X', areaHa: '1.00', regionCode: '00' }), {
      regionCode: ['validation.notFound'],
    });
    expectProblem(await updateField(client, UUID0, fieldBody()), 404, 'NOT_FOUND');
    expectErrors(await updateField(client, 'nope', fieldBody()), { id: ['validation.uuid'] });
  });

  it('delete: soft, 204; then 404 everywhere; the history stays in the audit log', async () => {
    const { client, field } = await farmWithField();
    expect((await createTreatment(client, field.id, await treatmentBody())).status).toBe(201);
    const del = await deleteField(client, field.id);
    expect(del.status, del.text).toBe(204);
    expectProblem(await getField(client, field.id), 404, 'NOT_FOUND');
    expectProblem(await deleteField(client, field.id), 404, 'NOT_FOUND');
    expectProblem(await updateField(client, field.id, fieldBody()), 404, 'NOT_FOUND');
    expectProblem(await listTreatments(client, field.id), 404, 'NOT_FOUND');
    expectProblem(await createTreatment(client, field.id, await treatmentBody()), 404, 'NOT_FOUND');
    expectProblem(await getField(await loginAs('INSPECTOR'), field.id), 404, 'NOT_FOUND');
    expect((await listFields(client)).body.total).toBe(0);
    const [audit] = await auditEntries({ action: 'deleteField', entityId: field.id });
    expect(Object.keys(audit!.diff)).toEqual(['deletedAt']);
    expect(audit!.diff.deletedAt![0]).toBeNull();
  });
});

describe('listFields', () => {
  it('q, regionCode; sort by name/areaHa/lastTreatmentAt (nulls last)/createdAt; counts of treatments', async () => {
    const { client } = await freshHead('FARM');
    const mk = async (name: string, areaHa: string, regionCode: string) => {
      const r = await createField(client, fieldBody({ name, areaHa, regionCode }));
      expect(r.status, r.text).toBe(201);
      return r.body.id as string;
    };
    const b = await mk('Берёзовое', '5.00', '33');
    const a = await mk('Абрикосовое', '50.00', '50');
    const c = await mk('Ёлочное', '0.50', '33');
    const subs = await substances();
    await createTreatment(client, b, await treatmentBody({ appliedAt: '2026-05-01T10:00:00Z' }));
    await createTreatment(
      client,
      b,
      await treatmentBody({ appliedAt: '2026-05-03T10:00:00Z', substanceId: subs[1]!.id }),
    );
    await createTreatment(client, a, await treatmentBody({ appliedAt: '2026-05-02T10:00:00Z' }));

    const ids = async (q: Record<string, string>) =>
      (await listFields(client, q)).body.items.map((f: { id: string }) => f.id);
    // Code-point order: А (U+0410) < Б (U+0411) < Ё (U+0401 — before А!)
    expect(await ids({})).toEqual([c, a, b]);
    expect(await ids({ sort: 'name,desc' })).toEqual([b, a, c]);
    expect(await ids({ sort: 'areaHa,desc' })).toEqual([a, b, c]);
    expect(await ids({ sort: 'lastTreatmentAt,desc' })).toEqual([b, a, c]);
    expect(await ids({ sort: 'lastTreatmentAt,asc' })).toEqual([a, b, c]);
    expect(await ids({ sort: 'createdAt,asc' })).toEqual([b, a, c]);
    expect(await ids({ q: 'ОВОЕ' })).toEqual([a, b]);
    expect(await ids({ regionCode: '33' })).toEqual([c, b]);
    const withB = (await getField(client, b)).body;
    expect(withB.treatmentsCount).toBe(2);
    expect(Date.parse(withB.lastTreatmentAt)).toBe(Date.parse('2026-05-03T10:00:00Z'));
    expectErrors(await listFields(client, { sort: 'region,asc', regionCode: 'x', q: '' }), {
      sort: ['validation.sort'],
      regionCode: ['validation.pattern'],
      q: ['validation.minLength'],
    });
  });
});

describe('treatments', () => {
  it('create → 201: substance ref, editableUntil = createdAt + 24 h; audit; INSPECTOR reads', async () => {
    const { client, field, user } = await farmWithField();
    const s = (await substances())[2]!;
    const res = await createTreatment(
      client,
      field.id,
      await treatmentBody({ substanceId: s.id, dose: '0.250', doseUnit: 'кг/га' }),
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      fieldId: field.id,
      substance: { id: s.id, name: s.name, type: s.type, waitingPeriodDays: s.waitingPeriodDays },
      dose: '0.250',
      doseUnit: 'кг/га',
    });
    // Instants compare as instants: the contract fixes ISO 8601 UTC with Z, not the fraction digits.
    expect(Date.parse(res.body.appliedAt)).toBe(Date.parse('2026-06-02T07:00:00Z'));
    expect(Date.parse(res.body.editableUntil) - Date.parse(res.body.createdAt)).toBe(DAY_MS);
    const [audit] = await auditEntries({ action: 'createTreatment', entityId: res.body.id });
    expect(audit).toMatchObject({ entityType: 'treatment', actor: { id: user.id } });
    expect(instants(audit!.diff)).toEqual(
      instants({
        fieldId: [null, field.id],
        substanceId: [null, s.id],
        dose: [null, '0.250'],
        doseUnit: [null, 'кг/га'],
        appliedAt: [null, res.body.appliedAt],
      }),
    );
    const inspector = await loginAs('INSPECTOR');
    const listed = await listTreatments(inspector, field.id);
    expect(instants(listed.body.items)).toEqual(instants([res.body]));
  });

  it('body errors: dose format/zero, unit, future appliedAt, unknown or deleted substance → 400', async () => {
    const { client, field } = await farmWithField();
    expectErrors(
      await createTreatment(client, field.id, await treatmentBody({ dose: '0.000', doseUnit: 'т/га' })),
      {
        dose: ['validation.dose.format'],
        doseUnit: ['validation.enum'],
      },
    );
    expectErrors(await createTreatment(client, field.id, await treatmentBody({ dose: '1.5' })), {
      dose: ['validation.dose.format'],
    });
    const future = new Date(Date.now() + 3600_000).toISOString();
    expectErrors(
      await createTreatment(client, field.id, await treatmentBody({ appliedAt: future, substanceId: UUID0 })),
      {
        substanceId: ['validation.notFound'],
        appliedAt: ['validation.date.future'],
      },
    );
    expectErrors(await createTreatment(client, field.id, await treatmentBody({ appliedAt: '2026-06-02' })), {
      appliedAt: ['validation.dateTime.format'],
    });
    // PL12: the year 0000 has no instant in the calendar of the store — a format error, never a 500.
    expectErrors(
      await createTreatment(client, field.id, await treatmentBody({ appliedAt: '0000-06-01T00:00:00Z' })),
      { appliedAt: ['validation.dateTime.format'] },
    );
    // Order: 404 for the field before the references of the body.
    expectProblem(
      await createTreatment(client, UUID0, await treatmentBody({ substanceId: UUID0 })),
      404,
      'NOT_FOUND',
    );
  });

  it('list: substanceId, from/to by UTC date inclusive, sort; from after to → 400 range', async () => {
    const { client, field } = await farmWithField();
    const subs = await substances();
    const at = async (appliedAt: string, substanceId = subs[0]!.id) => {
      const r = await createTreatment(client, field.id, await treatmentBody({ appliedAt, substanceId }));
      expect(r.status, r.text).toBe(201);
      return r.body.id as string;
    };
    const t1 = await at('2026-05-01T00:00:00Z');
    const t2 = await at('2026-05-01T23:59:59Z', subs[1]!.id);
    const t3 = await at('2026-05-02T00:00:00Z');
    const ids = async (q: Record<string, string>) =>
      (await listTreatments(client, field.id, q)).body.items.map((t: { id: string }) => t.id);
    expect(await ids({})).toEqual([t3, t2, t1]);
    expect(await ids({ sort: 'appliedAt,asc' })).toEqual([t1, t2, t3]);
    expect(await ids({ sort: 'createdAt,asc' })).toEqual([t1, t2, t3]);
    expect(await ids({ from: '2026-05-01', to: '2026-05-01' })).toEqual([t2, t1]);
    expect(await ids({ from: '2026-05-02' })).toEqual([t3]);
    expect(await ids({ to: '2026-04-30' })).toEqual([]);
    expect(await ids({ substanceId: subs[1]!.id })).toEqual([t2]);
    expectErrors(await listTreatments(client, field.id, { from: '2026-05-02', to: '2026-05-01' }), {
      from: ['validation.range'],
    });
    expectErrors(
      await listTreatments(client, field.id, { from: '2026-13-01', substanceId: 'x', sort: 'dose,asc' }),
      {
        from: ['validation.date.format'],
        substanceId: ['validation.uuid'],
        sort: ['validation.sort'],
      },
    );
  });

  it('update within the window → 200 (createdAt and editableUntil unchanged); audit diff', async () => {
    const { client, field } = await farmWithField();
    const t = (await createTreatment(client, field.id, await treatmentBody())).body;
    const subs = await substances();
    const res = await updateTreatment(
      client,
      t.id,
      await treatmentBody({ substanceId: subs[3]!.id, dose: '2.000' }),
    );
    expect(res.status, res.text).toBe(200);
    expect(instants(res.body)).toMatchObject(
      instants({
        id: t.id,
        substance: { id: subs[3]!.id },
        dose: '2.000',
        createdAt: t.createdAt,
        editableUntil: t.editableUntil,
      }),
    );
    const [audit] = await auditEntries({ action: 'updateTreatment', entityId: t.id });
    expect(audit!.diff).toEqual({ substanceId: [subs[0]!.id, subs[3]!.id], dose: ['1.500', '2.000'] });
    expectProblem(await updateTreatment(client, UUID0, await treatmentBody()), 404, 'NOT_FOUND');
    const zarya = await loginAs('FARMER', { key: 'zarya.head' });
    expectProblem(await updateTreatment(zarya, t.id, await treatmentBody()), 404, 'NOT_FOUND');
  });

  it('edit window: inside (just under 24 h) → 200; past it → 403 EDIT_WINDOW_CLOSED {editableUntil}, before body references', async () => {
    const { client, field } = await farmWithField();
    const t = (await createTreatment(client, field.id, await treatmentBody())).body;
    // A fixture write: the 24-hour clock cannot be waited for.
    await fixtureWrite(
      `UPDATE treatments SET created_at = now() - interval '23 hours 59 minutes 50 seconds' WHERE id = $1`,
      [t.id],
    );
    const inside = await updateTreatment(client, t.id, await treatmentBody({ dose: '3.000' }));
    expect(inside.status, inside.text).toBe(200);
    expect(Date.parse(inside.body.editableUntil) - Date.now()).toBeLessThan(15_000);

    await fixtureWrite(
      `UPDATE treatments SET created_at = now() - interval '24 hours 1 second' WHERE id = $1`,
      [t.id],
    );
    const listed = (await listTreatments(client, field.id)).body.items[0];
    const closed = await updateTreatment(client, t.id, await treatmentBody({ substanceId: UUID0 }));
    expectProblem(closed, 403, 'FORBIDDEN', {
      reason: 'EDIT_WINDOW_CLOSED',
      editableUntil: listed.editableUntil,
    });
    // Schema errors still come first.
    expectErrors(await updateTreatment(client, t.id, await treatmentBody({ dose: 'x' })), {
      dose: ['validation.dose.format'],
    });
  });

  it('a treatment of a deleted field is gone (404); the update checks the field visibility', async () => {
    const { client, field } = await farmWithField();
    const t = (await createTreatment(client, field.id, await treatmentBody())).body;
    expect((await deleteField(client, field.id)).status).toBe(204);
    expectProblem(await updateTreatment(client, t.id, await treatmentBody()), 404, 'NOT_FOUND');
  });
});
