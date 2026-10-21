/**
 * Lab (contracts/openapi/paths/lab.yaml; БП-2, FR-QA-02…05, BR-02, D4, R57, T9 note a) and the recall engine core it
 * starts on FAIL (tag Recalls, steps 1–7, P2): the queue and its visibility (own laboratory, participants through the
 * batch, INSPECTOR/ADMIN all), filters (batchId, labOrgId R51, overdue, from/to by UTC date), the inspector's
 * unplanned test, sample registration, results (the exact indicator set, strict `>`, the norm snapshot, PASS →
 * Approved, FAIL → Blocked → Recalled with tasks, `recallId` in the answer and in `lab_tests.recall_id`, reuse of an
 * OPEN recall of the source, the vacuous BR-10 close with RECALL CLOSED), the outbox rows (LAB_ASSIGNED, LAB_RESULT,
 * rating.recalculate, recall.requested), the protocol (PDF ≤ 10 MiB inclusive, replacement, download), and the
 * `lab-escalation` scheduler.
 *
 * Time control (Review Focus 4): tests never move a clock. A lab test is made overdue by a documented fixture write
 * of its `due_at` in the shared DB (lib/db.ts fixtureWrite), and the test stand runs the scheduler with
 * `SCHEDULER_TICK_MS` = 1000 (deployment configuration of the test stand, contract info.description) instead of
 * 5 minutes; every backend honours both, so the suite stays backend-agnostic. `./at api:test <back> --tz
 * Europe/Moscow` runs the same suite with the backend's processes in Moscow time: every date rule must still be UTC.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { auditEntries } from './lib/audit.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { API_BACKEND } from './lib/env.js';
import { closeDb, dbNow, fixtureWrite, outboxEvents, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { apiPath, contentDisposition, fixture, sha256hex, upload } from './lib/files.js';
import { registerOrg } from './lib/fixtures.js';
import {
  approvedBatch,
  createBatch,
  daysAgo,
  deliver,
  eventually,
  flour,
  freshOrg,
  getBatch,
  newField,
  petrov,
  processBatches,
  sentWaybill,
} from './lib/production.js';
import { freshFarm, labApproved } from './lib/quality.js';
import { closeRedis, redis } from './lib/redis.js';
import { instant, instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const BACKEND = API_BACKEND;
const UUID0 = '00000000-0000-4000-8000-000000000000';
const PROTOCOL_MAX = 10 * 1024 * 1024;
const DAY = 86_400_000;
const LAB_REASON = 'Превышение нормативов по результатам лабораторного анализа';

/** R24: N working days (Mon–Fri by UTC date), time of day kept. */
function addWorkingDays(from: string, days: number): string {
  const d = new Date(from);
  for (let left = days; left > 0;) {
    d.setTime(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString();
}

type LabTest = {
  id: string;
  batch: { id: string; publicCode: string; status: string };
  lab: { id: string };
  reason: string;
  status: string;
  conclusion: string | null;
  dueAt: string;
  overdue: boolean;
  createdAt: string;
  sampledAt: string | null;
  completedAt: string | null;
  hasProtocol: boolean;
  escalatedAt: string | null;
  results: {
    indicatorId: string;
    name: string;
    unit: string;
    value: string;
    normValue: string;
    isExceeded: boolean;
  }[];
  protocol: { id: string; url: string; mime: string; sizeBytes: number; originalName: string } | null;
  norms: { indicatorId: string; name: string; unit: string; maxValue: string }[];
  recallId: string | null;
  version: number;
  actions: string[];
};

async function listTests(client: ApiClient, q: Record<string, string | number | boolean> = {}) {
  const res = await client.get('/lab-tests', { query: q });
  await expectContract(res, 'listLabTests');
  return res;
}
async function getTest(client: ApiClient, id: string) {
  const res = await client.get(`/lab-tests/${id}`);
  await expectContract(res, 'getLabTest');
  return res;
}
async function createTest(client: ApiClient, body: unknown) {
  const res = await client.post('/lab-tests', body);
  await expectContract(res, 'createLabTest');
  return res;
}
async function sample(client: ApiClient, id: string, version: number | undefined, body?: unknown) {
  const res = await client.post(`/lab-tests/${id}/sample`, body, {
    headers: version === undefined ? {} : { 'If-Match': String(version) },
  });
  await expectContract(res, 'registerLabSample');
  return res;
}
async function submit(client: ApiClient, id: string, version: number | undefined, results: unknown) {
  const res = await client.post(
    `/lab-tests/${id}/results`,
    { results },
    { headers: version === undefined ? {} : { 'If-Match': String(version) } },
  );
  await expectContract(res, 'submitLabResults');
  return res;
}
async function putProtocol(client: ApiClient, id: string, data: Buffer, filename = 'protokol.pdf') {
  const res = await upload(client, `/lab-tests/${id}/protocol`, {
    data,
    filename,
    contentType: 'application/pdf',
  });
  await expectContract(res, 'uploadLabProtocol');
  return res;
}
async function getProtocol(client: ApiClient, id: string, headers: Record<string, string> = {}) {
  const res = await client.get(`/lab-tests/${id}/protocol`, { headers });
  await expectContract(res, 'downloadLabProtocol');
  return res;
}

/** A PDF (by signature) of exactly `size` bytes. */
function pdfOfSize(size: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 0x20), tail]);
}

const rand = () => randomBytes(3).toString('hex');

interface TestProduct {
  id: string;
  norms: { indicatorId: string; name: string; unit: string; maxValue: string; normId: string }[];
}

let admin: ApiClient;
/** A fresh GRAIN product with two norms (names chosen so code-point order ≠ creation order), or none. */
async function testProduct(withNorms = true): Promise<TestProduct> {
  const r = rand();
  const p = await admin.post('/dictionaries/products', {
    name: `Тест-зерно ${r}`,
    category: 'GRAIN',
    lossNormPercent: '1.00',
  });
  expect(p.status, p.text).toBe(201);
  const norms: TestProduct['norms'] = [];
  if (withNorms)
    for (const [name, unit, maxValue] of [
      [`Я-показатель ${r}`, 'мг/кг', '0.5'],
      [`А-показатель ${r}`, 'мкг/кг', '10'],
    ] as const) {
      const ind = await admin.post('/dictionaries/indicators', { name, unit });
      expect(ind.status, ind.text).toBe(201);
      const n = await admin.post('/dictionaries/norms', {
        productId: p.body.id,
        indicatorId: ind.body.id,
        maxValue,
      });
      expect(n.status, n.text).toBe(201);
      norms.push({ indicatorId: ind.body.id, name, unit, maxValue: n.body.maxValue, normId: n.body.id });
    }
  norms.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { id: p.body.id, norms };
}

interface NewFarm {
  client: ApiClient;
  orgId: string;
  field: { id: string };
}
/** A fresh farm (fewer than 5 batches → NEW_FARM: every batch goes OnTest, reason RISK). */
async function newFarm(): Promise<NewFarm> {
  const f = await freshOrg('FARM');
  return { client: f.client, orgId: f.orgId, field: await newField(f.client) };
}

let inspector: ApiClient;
const labs = new Map<string, ApiClient>();
let product: TestProduct;
let fresh: NewFarm;

let freshUsed = 0;
/**
 * A batch of a fresh farm on test (`risk` — the RISK test createBatch assigned, as the inspector sees it) and an
 * INSPECTOR test of the same batch in the seeded laboratory `lab` (`test`, version 1): createBatch picks the least
 * loaded ACTIVE laboratory, which may be one another suite registered, so the tests act through a known one. `other`
 * — the other seeded laboratory. `fresh` is the farm of the latest call: a farm leaves NEW_FARM after five raw
 * batches, so every fifth call starts a new one.
 */
async function onTest(productId = product.id) {
  if (freshUsed >= 5) {
    fresh = await newFarm();
    freshUsed = 0;
  }
  freshUsed++;
  const f = fresh;
  const b = await createBatch(f.client, {
    fieldId: f.field.id,
    productId,
    massKg: '100.000',
    harvestedAt: daysAgo(1),
  });
  expect(b.status, b.text).toBe(201);
  expect(b.body.status).toBe('OnTest');
  const l = await listTests(inspector, { batchId: b.body.id });
  expect(l.body.total).toBe(1);
  const risk = (await getTest(inspector, l.body.items[0].id)).body as LabTest;
  const [[labId, lab], [, other]] = [...labs.entries()] as [[string, ApiClient], [string, ApiClient]];
  const created = await createTest(inspector, { batchId: b.body.id, labOrgId: labId });
  expect(created.status, created.text).toBe(201);
  const test = created.body as LabTest;
  return { batch: b.body as { id: string; publicCode: string; version: number }, risk, test, lab, other };
}

const valuesOf = (t: { norms: LabTest['norms'] }, v: (n: LabTest['norms'][number], i: number) => string) =>
  t.norms.map((n, i) => ({ indicatorId: n.indicatorId, value: v(n, i) }));

beforeAll(async () => {
  admin = await loginAs('ADMIN', { head: true });
  inspector = await loginAs('INSPECTOR');
  for (const key of ['vetlab.head', 'agrotest.head']) {
    const c = await loginAs('LAB', { key });
    const me = await c.get('/me');
    labs.set(me.body.organization.id, c);
  }
  product = await testProduct();
  fresh = await newFarm();
});

describe('queue and visibility', () => {
  it('createBatch assigns a RISK test: QUEUED, dueAt = addWorkingDays(createdAt, 5), current norms by name; actions by role', async () => {
    const { risk, test, lab, other, batch } = await onTest();
    for (const t of [risk, test])
      expect(t).toMatchObject({
        status: 'QUEUED',
        conclusion: null,
        overdue: false,
        sampledAt: null,
        completedAt: null,
        hasProtocol: false,
        escalatedAt: null,
        results: [],
        protocol: null,
        recallId: null,
        version: 1,
        actions: [],
      });
    expect(risk.reason).toBe('RISK');
    expect(instant(risk.dueAt)).toBe(instant(addWorkingDays(risk.createdAt, 5)));
    expect(risk.norms).toEqual(
      product.norms.map(({ indicatorId, name, unit, maxValue }) => ({ indicatorId, name, unit, maxValue })),
    );
    expect(risk.norms.map((n) => n.maxValue)).toEqual(['10.000000', '0.500000']);
    const mine = await getTest(lab, test.id);
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.actions).toEqual(['sample', 'submitResults', 'uploadProtocol']);
    // Another laboratory, another farm: invisible (404, never 403).
    expectProblem(await getTest(other, test.id), 404, 'NOT_FOUND');
    expectProblem(await getTest((await petrov()).client, test.id), 404, 'NOT_FOUND');
    expectProblem(await getTest(inspector, UUID0), 404, 'NOT_FOUND');
    expectErrors(await getTest(lab, 'not-a-uuid'), { id: ['validation.uuid'] });
    // The farm sees the tests of its batch (read-only).
    for (const t of [risk, test]) {
      const own = await getTest(fresh.client, t.id);
      expect(own.status).toBe(200);
      expect(own.body.actions).toEqual([]);
      expect(own.body.batch).toMatchObject({ id: batch.id, status: 'OnTest' });
    }
    expect((await getTest(admin, test.id)).status).toBe(200);
  });

  it('listLabTests: own laboratory only for LAB; batchId for participants (T9 note a); labOrgId only INSPECTOR/ADMIN (R51)', async () => {
    const { risk, test, lab, other, batch } = await onTest();
    const ids = async (c: ApiClient, q: Record<string, string> = {}) =>
      (await listTests(c, { size: 100, ...q })).body.items as { id: string; lab: { id: string } }[];
    const own = await ids(lab, { batchId: batch.id });
    expect(own.map((x) => x.id)).toContain(test.id);
    for (const x of own) expect(x.lab.id).toBe(test.lab.id);
    expect((await ids(other, { batchId: batch.id })).map((x) => x.id)).not.toContain(test.id);
    for (const x of await ids(lab)) expect(x.lab.id).toBe(test.lab.id);
    expect((await ids(fresh.client, { batchId: batch.id })).map((x) => x.id).sort()).toEqual(
      [risk.id, test.id].sort(),
    );
    // A batch the participant does not see: an empty page, not an error.
    expect(await ids((await petrov()).client, { batchId: batch.id })).toEqual([]);
    expect(await ids(fresh.client, { batchId: UUID0 })).toEqual([]);
    expectErrors(await listTests(lab, { labOrgId: test.lab.id }), {
      labOrgId: ['validation.labOrgId.notAllowed'],
    });
    expectErrors(await listTests(fresh.client, { labOrgId: test.lab.id }), {
      labOrgId: ['validation.labOrgId.notAllowed'],
    });
    const byLab = await ids(inspector, { labOrgId: risk.lab.id, batchId: batch.id });
    expect(byLab.map((x) => x.id)).toContain(risk.id);
    expect(await ids(admin, { labOrgId: UUID0, batchId: batch.id })).toEqual([]);
    expectErrors(await listTests(inspector, { sort: 'version,asc' }), { sort: ['validation.sort'] });
    expectErrors(await listTests(inspector, { status: 'NOPE' }), { status: ['validation.enum'] });
    expectErrors(await listTests(inspector, { batchId: 'x' }), { batchId: ['validation.uuid'] });
    // q — publicCode substring, case-insensitive; status / reason / conclusion / overdue filters.
    const q = await ids(inspector, { q: batch.publicCode.toLowerCase() });
    expect(q.map((x) => x.id)).toContain(test.id);
    expect((await ids(inspector, { batchId: batch.id, status: 'DONE' })).length).toBe(0);
    expect(
      (await ids(inspector, { batchId: batch.id, status: 'QUEUED', reason: 'RISK' })).map((x) => x.id),
    ).toEqual([risk.id]);
    expect((await ids(inspector, { batchId: batch.id, reason: 'INSPECTOR' })).map((x) => x.id)).toEqual([
      test.id,
    ]);
    expect((await ids(inspector, { batchId: batch.id, reason: 'PLANNED' })).length).toBe(0);
    expect((await ids(inspector, { batchId: batch.id, conclusion: 'PASS' })).length).toBe(0);
    expect((await ids(inspector, { batchId: batch.id, overdue: 'false' })).length).toBe(2);
    expect((await ids(inspector, { batchId: batch.id, overdue: 'true' })).length).toBe(0);
  });

  it('x-sort dueAt asc by default; createdAt/completedAt; nulls last', async () => {
    const res = await listTests(inspector, { size: 100 });
    const due = (res.body.items as { dueAt: string }[]).map((x) => instant(x.dueAt));
    expect([...due].sort((a, b) => a - b)).toEqual(due);
    const done = await listTests(inspector, { size: 100, sort: 'completedAt,desc' });
    const completed = (done.body.items as { completedAt: string | null }[]).map((x) => x.completedAt);
    const firstNull = completed.indexOf(null);
    if (firstNull >= 0) expect(completed.slice(firstNull).every((x) => x === null)).toBe(true);
    const nonNull = completed.filter((x): x is string => x !== null).map((x) => instant(x));
    expect([...nonNull].sort((a, b) => b - a)).toEqual(nonNull);
  });

  it('from/to filter by the UTC date of createdAt (a test created at 23:30Z belongs to that UTC day)', async () => {
    const { test, batch } = await onTest();
    // Fixture write: a creation instant at the end of a UTC day (in Moscow it is already the next day). The API
    // cannot create a test at a chosen moment; createdAt is not rewritten by any operation.
    await fixtureWrite(`UPDATE lab_tests SET created_at = '2026-03-06T23:30:00Z' WHERE id = $1`, [test.id]);
    const ids = async (q: Record<string, string>) =>
      (
        (await listTests(inspector, { batchId: batch.id, reason: 'INSPECTOR', ...q })).body.items as {
          id: string;
        }[]
      ).map((x) => x.id);
    expect(await ids({ from: '2026-03-06', to: '2026-03-06' })).toEqual([test.id]);
    expect(await ids({ from: '2026-03-07' })).toEqual([]);
    expect(await ids({ to: '2026-03-05' })).toEqual([]);
    expect(await ids({ to: '2026-03-06' })).toEqual([test.id]);
    expectErrors(await listTests(inspector, { from: '2026-03-07', to: '2026-03-06' }), {
      from: ['validation.range'],
    });
  });
});

describe('createLabTest (INSPECTOR)', () => {
  it('x-roles; body by schema; references in one 400 (batch, lab not ACTIVE, not a LAB)', async () => {
    const b = await approvedBatch(await petrov());
    const labId = [...labs.keys()][0]!;
    for (const role of ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'ADMIN'] as Role[])
      expectProblem(
        await createTest(await loginAs(role), { batchId: b.id, labOrgId: labId }),
        403,
        'FORBIDDEN',
        null,
      );
    expectErrors(await createTest(inspector, {}), {
      batchId: ['validation.required'],
      labOrgId: ['validation.required'],
    });
    expectErrors(await createTest(inspector, { batchId: 'x', labOrgId: labId, extra: 1 }), {
      batchId: ['validation.uuid'],
      extra: ['validation.unknownField'],
    });
    expectErrors(await createTest(inspector, { batchId: UUID0, labOrgId: UUID0 }), {
      batchId: ['validation.notFound'],
      labOrgId: ['validation.notFound'],
    });
    const pending = await registerOrg('LAB'); // registered, not approved: not ACTIVE
    expectErrors(await createTest(inspector, { batchId: b.id, labOrgId: pending.organizationId }), {
      labOrgId: ['validation.notFound'],
    });
    expectErrors(await createTest(inspector, { batchId: b.id, labOrgId: (await petrov()).orgId }), {
      labOrgId: ['validation.labOrg.type'],
    });
  });

  it('QUEUED INSPECTOR test (dueAt = +5 working days, version 1), batch status unchanged, LAB_ASSIGNED in the outbox', async () => {
    const farm = await petrov();
    const b = await approvedBatch(farm);
    const [labId, lab] = [...labs.entries()][1]!;
    const since = await dbNow();
    const res = await createTest(inspector, { batchId: b.id, labOrgId: labId });
    expect(res.status, res.text).toBe(201);
    const t = res.body as LabTest;
    expect(t).toMatchObject({
      reason: 'INSPECTOR',
      status: 'QUEUED',
      lab: { id: labId },
      batch: { id: b.id, status: 'Approved' },
      version: 1,
      recallId: null,
      actions: [],
    });
    expect(instant(t.dueAt)).toBe(instant(addWorkingDays(t.createdAt, 5)));
    expect((await getBatch(farm.client, b.id)).body).toMatchObject({
      status: 'Approved',
      version: b.version,
    });
    // The lab now sees the batch (a non-deleted test of its laboratory).
    expect((await getBatch(lab, b.id)).status).toBe(200);
    expect((await getTest(lab, t.id)).body.actions).toEqual(['sample', 'submitResults', 'uploadProtocol']);
    const ev = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })).filter(
      (e) => e.payload.data.payload.labTestId === t.id,
    );
    expect(ev.length).toBe(1);
    expect(instants(ev[0]!.payload.data)).toMatchObject(
      instants({
        notificationType: 'LAB_ASSIGNED',
        recipients: { orgIds: [labId, farm.orgId], userIds: [], orgHeadIds: [], roles: [] },
        payload: {
          batchId: b.id,
          publicCode: b.publicCode,
          labOrgId: labId,
          reason: 'INSPECTOR',
          dueAt: t.dueAt,
        },
      }),
    );
    const audit = await auditEntries({ action: 'createLabTest', entityId: t.id });
    expect(audit.length).toBe(1);
    expect(audit[0]!.diff).toMatchObject({ status: [null, 'QUEUED'], reason: [null, 'INSPECTOR'] });
  });
});

describe('registerLabSample', () => {
  it('If-Match required; body {} or none; 404 for another lab; VERSION_CONFLICT; QUEUED → SAMPLED; then INVALID_TRANSITION', async () => {
    const { test, lab, other } = await onTest();
    expectProblem(await sample(fresh.client, test.id, 1), 403, 'FORBIDDEN', null);
    expectErrors(await sample(lab, test.id, undefined), { 'If-Match': ['validation.required'] });
    expectErrors(await sample(lab, test.id, 1, { x: 1 }), { x: ['validation.unknownField'] });
    expectProblem(await sample(other, test.id, 1), 404, 'NOT_FOUND');
    expectProblem(await sample(lab, test.id, 7), 409, 'VERSION_CONFLICT', { currentVersion: 1 });
    const res = await sample(lab, test.id, 1, {});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      status: 'SAMPLED',
      version: 2,
      actions: ['submitResults', 'uploadProtocol'],
    });
    expect(Date.parse(res.body.sampledAt)).toBeGreaterThan(Date.now() - 60_000);
    expectProblem(await sample(lab, test.id, 2), 409, 'INVALID_TRANSITION', {
      from: 'SAMPLED',
      to: 'SAMPLED',
    });
    const audit = await auditEntries({ action: 'registerLabSample', entityId: test.id });
    expect(audit[0]!.diff).toMatchObject({ status: ['QUEUED', 'SAMPLED'], version: [1, 2] });
  });
});

describe('submitLabResults', () => {
  it('check order: schema → 404 → If-Match → indicator set (duplicate, mismatch — one 400)', async () => {
    const { test, lab, other } = await onTest();
    const good = valuesOf(test, () => '0.1');
    expectProblem(await submit(fresh.client, test.id, 1, good), 403, 'FORBIDDEN', null);
    expectErrors(await submit(lab, test.id, 1, []), { results: ['validation.minItems'] });
    expectErrors(
      await submit(lab, test.id, 1, [{ indicatorId: test.norms[0]!.indicatorId, value: '1.1234567' }]),
      {
        'results[0].value': ['validation.decimal.format'],
      },
    );
    expectErrors(await submit(lab, test.id, undefined, [{ indicatorId: 'x', value: '1' }]), {
      'If-Match': ['validation.required'],
      'results[0].indicatorId': ['validation.uuid'],
    });
    // A repeated indicator is step 5: after 404 and If-Match.
    const dup = [good[0]!, good[0]!, good[1]!];
    expectProblem(await submit(other, test.id, 1, dup), 404, 'NOT_FOUND');
    expectProblem(await submit(lab, test.id, 3, dup), 409, 'VERSION_CONFLICT', { currentVersion: 1 });
    expectErrors(await submit(lab, test.id, 1, dup), { 'results[1].indicatorId': ['validation.duplicate'] });
    expectErrors(await submit(lab, test.id, 1, [good[0]!]), { results: ['validation.results.mismatch'] });
    expectErrors(await submit(lab, test.id, 1, [...good, { indicatorId: UUID0, value: '1' }]), {
      results: ['validation.results.mismatch'],
    });
    expectErrors(await submit(lab, test.id, 1, [good[0]!, good[0]!]), {
      'results[1].indicatorId': ['validation.duplicate'],
      results: ['validation.results.mismatch'],
    });
    expect((await getTest(lab, test.id)).body).toMatchObject({ status: 'QUEUED', version: 1 });
  });

  it('a product without norms: any result set is a mismatch', async () => {
    const bare = await testProduct(false);
    const { test, lab } = await onTest(bare.id);
    expect(test.norms).toEqual([]);
    expectErrors(await submit(lab, test.id, 1, [{ indicatorId: UUID0, value: '1' }]), {
      results: ['validation.results.mismatch'],
    });
  });

  it('PASS (value = norm is not exceeded, BR-02 strict >): DONE, Approved (LAB_PASS), snapshot, LAB_RESULT, rating.recalculate', async () => {
    const { test, lab, batch } = await onTest();
    await redis().set(`pub:batch:${batch.publicCode}`, '{"stale":true}', 'EX', 300);
    const since = await dbNow();
    // Values exactly at the norm (10 → '10', 0.5 → '0.500000').
    const res = await submit(
      lab,
      test.id,
      1,
      valuesOf(test, (n, i) => (i === 0 ? '10' : '0.500000')),
    );
    expect(res.status, res.text).toBe(200);
    const t = res.body as LabTest;
    expect(t).toMatchObject({ status: 'DONE', conclusion: 'PASS', version: 2, recallId: null });
    expect(t.completedAt).not.toBeNull();
    expect(instant(t.sampledAt!)).toBe(instant(t.completedAt!)); // not sampled before: sampledAt = completion time
    expect(t.results).toEqual(
      test.norms.map((n) => ({
        indicatorId: n.indicatorId,
        name: n.name,
        unit: n.unit,
        value: n.maxValue,
        normValue: n.maxValue,
        isExceeded: false,
      })),
    );
    expect(t.norms).toEqual(test.norms);
    expect(t.actions).toEqual(['uploadProtocol']);
    expect(t.batch.status).toBe('Approved');
    const card = (await getBatch(fresh.client, batch.id)).body;
    expect(card).toMatchObject({ status: 'Approved', version: batch.version + 1 });
    const h = await fresh.client.get(`/batches/${batch.id}/history`);
    expect(h.body.at(-1)).toMatchObject({ from: 'OnTest', to: 'Approved', reason: 'LAB_PASS' });
    expect(h.body.at(-1).changedBy).not.toBeNull();
    expect(await redis().exists(`pub:batch:${batch.publicCode}`)).toBe(0);
    expectProblem(
      await submit(
        lab,
        test.id,
        2,
        valuesOf(test, () => '1'),
      ),
      409,
      'INVALID_TRANSITION',
      {
        from: 'DONE',
        to: 'DONE',
      },
    );

    const notes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })).filter(
      (e) => e.payload.data.payload.labTestId === test.id,
    );
    expect(notes.map((e) => e.payload.data)).toEqual([
      {
        notificationType: 'LAB_RESULT',
        // holder = origin: one organization; an INSPECTOR test also goes to the inspectors.
        recipients: { userIds: [], orgIds: [fresh.orgId], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          labTestId: test.id,
          batchId: batch.id,
          publicCode: batch.publicCode,
          productName: expect.any(String),
          conclusion: 'PASS',
          recallId: null,
        },
      },
    ]);
    const rating = (await outboxEvents({ backend: BACKEND, type: 'rating.recalculate', since })).filter(
      (e) => e.payload.data.sourceId === test.id,
    );
    expect(rating.map((e) => e.payload.data)).toEqual([
      { organizationId: fresh.orgId, cause: 'LAB_PASS', sourceId: test.id },
    ]);
    const audit = await auditEntries({ action: 'submitLabResults', entityId: test.id });
    expect(audit[0]!.diff).toMatchObject({ status: ['QUEUED', 'DONE'], conclusion: [null, 'PASS'] });
  });

  it('the norm snapshot: a later norm change does not alter submitted results; an open test sees the new norm', async () => {
    const own = await testProduct();
    const done = await onTest(own.id);
    const open = await onTest(own.id);
    const res = await submit(
      done.lab,
      done.test.id,
      1,
      valuesOf(done.test, () => '0.1'),
    );
    expect(res.status, res.text).toBe(200);
    const n = own.norms[1]!; // '0.500000'
    const upd = await admin.put(`/dictionaries/norms/${n.normId}`, {
      productId: own.id,
      indicatorId: n.indicatorId,
      maxValue: '0.05',
    });
    expect(upd.status, upd.text).toBe(200);
    const after = (await getTest(done.lab, done.test.id)).body as LabTest;
    expect(after.results.find((r) => r.indicatorId === n.indicatorId)).toMatchObject({
      value: '0.100000',
      normValue: '0.500000',
      isExceeded: false,
    });
    expect(after.norms.find((x) => x.indicatorId === n.indicatorId)!.maxValue).toBe('0.500000');
    const live = (await getTest(open.lab, open.test.id)).body as LabTest;
    expect(live.norms.find((x) => x.indicatorId === n.indicatorId)!.maxValue).toBe('0.050000');
  });

  it('FAIL (one value above by 0.000001): Blocked → Recalled, a new LAB recall with the task, recallId stored (R57)', async () => {
    const { test, lab, batch } = await onTest();
    await sample(lab, test.id, 1);
    const since = await dbNow();
    const res = await submit(
      lab,
      test.id,
      2,
      valuesOf(test, (n, i) => (i === 0 ? '10.000001' : '0.1')),
    );
    expect(res.status, res.text).toBe(200);
    const t = res.body as LabTest;
    expect(t).toMatchObject({ status: 'DONE', conclusion: 'FAIL', version: 3 });
    expect(t.results.map((r) => r.isExceeded)).toEqual([true, false]);
    expect(t.recallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(instant(t.sampledAt!)).not.toBe(instant(t.completedAt!));
    expect((await getTest(fresh.client, test.id)).body.recallId).toBe(t.recallId);
    const [row] = await query<{ recall_id: string }>(`SELECT recall_id FROM lab_tests WHERE id = $1`, [
      test.id,
    ]);
    expect(row!.recall_id).toBe(t.recallId);

    const card = (await getBatch(fresh.client, batch.id)).body;
    expect(card).toMatchObject({ status: 'Recalled', version: batch.version + 2 });
    const h = (await fresh.client.get(`/batches/${batch.id}/history`)).body as {
      from: string;
      to: string;
      reason: string;
    }[];
    expect(h.slice(-2).map((x) => [x.from, x.to, x.reason])).toEqual([
      ['OnTest', 'Blocked', 'LAB_FAIL'],
      ['Blocked', 'Recalled', 'RECALLED'],
    ]);

    // Task 10's getRecall/listRecallTasks will show these through the API.
    const [recall] = await query(
      `SELECT source_batch_id, trigger, reason, status, block_upstream, lab_test_id, complaint_id, opened_at, closed_at,
              version, created_by FROM recalls WHERE id = $1`,
      [t.recallId],
    );
    expect(recall).toMatchObject({
      source_batch_id: batch.id,
      trigger: 'LAB',
      reason: LAB_REASON,
      status: 'OPEN',
      block_upstream: false,
      lab_test_id: test.id,
      complaint_id: null,
      closed_at: null,
      version: 1,
    });
    const members = await query(
      `SELECT batch_id, direction, depth, status_before FROM recall_batches WHERE recall_id = $1`,
      [t.recallId],
    );
    expect(members).toEqual([
      { batch_id: batch.id, direction: 'SOURCE', depth: 0, status_before: 'Blocked' },
    ]);
    const tasks = await query<{
      holder_org_id: string;
      batch_id: string;
      due_at: Date;
      status: string;
      version: number;
    }>(`SELECT holder_org_id, batch_id, due_at, status, version FROM recall_tasks WHERE recall_id = $1`, [
      t.recallId,
    ]);
    expect(tasks).toEqual([
      {
        holder_org_id: fresh.orgId,
        batch_id: batch.id,
        due_at: new Date(new Date(recall!.opened_at).getTime() + DAY),
        status: 'OPEN',
        version: 1,
      },
    ]);

    const requested = (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since })).filter(
      (e) => e.payload.data.recallId === t.recallId,
    );
    expect(requested.map((e) => e.payload.data)).toEqual([
      { recallId: t.recallId, sourceBatchId: batch.id, trigger: 'LAB', openedBy: recall!.created_by },
    ]);
    const notes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.payload.labTestId === test.id || d.payload.recallId === t.recallId);
    // LAB_RESULT now; RECALL OPENED / RECALL_TASK CREATED come from the recall.requested handler (asynchronous).
    expect(notes.map((d) => d.notificationType)).toEqual(['LAB_RESULT']);
    expect(notes[0]!.payload).toMatchObject({ conclusion: 'FAIL', recallId: t.recallId });
    const rating = (await outboxEvents({ backend: BACKEND, type: 'rating.recalculate', since })).filter(
      (e) => e.payload.data.sourceId === test.id,
    );
    expect(rating.map((e) => e.payload.data.cause)).toEqual(['LAB_FAIL']);
  });

  it('FAIL of an unplanned test on a processed batch: the downward recall (holders, InTransit receiver, depth); an OPEN recall is reused; a recall without tasks closes at once (BR-10)', async () => {
    // A fresh farm, not «КФХ Петров»: the FAIL and the recall lower the source farm's rating (BR-09, lib/quality.ts).
    const farm = await freshFarm();
    const processor = await freshOrg('PROCESSOR');
    const retailer = await freshOrg('RETAILER');
    const flourId = (await flour()).id;
    // A (farm) → processor → O1, O2; O1 shipped to the retailer (InTransit); O2 → O3.
    const a0 = await labApproved(farm);
    await deliver(farm.client, processor, a0);
    const a = (await getBatch(processor.client, a0.id)).body as { id: string; publicCode: string };
    const p1 = await processBatches(
      processor.client,
      [{ batchId: a.id, massUsedKg: '100.000' }],
      [
        { productId: flourId, massKg: '40.000' },
        { productId: flourId, massKg: '40.000' },
      ],
    );
    expect(p1.status, p1.text).toBe(201);
    const [o1, o2] = p1.body.outputs as { id: string; publicCode: string; massKg: string }[];
    await sentWaybill(processor.client, retailer.orgId, [o1!]);
    const p2 = await processBatches(
      processor.client,
      [{ batchId: o2!.id, massUsedKg: '40.000' }],
      [{ productId: flourId, massKg: '30.000' }],
    );
    expect(p2.status, p2.text).toBe(201);
    const o3 = p2.body.outputs[0] as { id: string; publicCode: string };

    const [labId, lab] = [...labs.entries()][0]!;
    const assign = async (batchId: string) => {
      const r = await createTest(inspector, { batchId, labOrgId: labId });
      expect(r.status, r.text).toBe(201);
      return r.body as LabTest;
    };
    const fail = (t: LabTest) => valuesOf(t, () => '99999');
    const t1 = await assign(a.id);
    expect(t1.norms.length).toBeGreaterThan(0);
    const since = await dbNow();
    const r1 = await submit(lab, t1.id, 1, fail(t1));
    expect(r1.status, r1.text).toBe(200);
    const recallId = r1.body.recallId as string;
    // The source is Processed: no transition (not OnTest), no task of its own.
    expect((await getBatch(processor.client, a.id)).body.status).toBe('Processed');
    const members = await query(
      `SELECT batch_id, direction, depth, status_before FROM recall_batches WHERE recall_id = $1 ORDER BY depth, batch_id`,
      [recallId],
    );
    expect(members).toEqual(
      [
        { batch_id: a.id, direction: 'SOURCE', depth: 0, status_before: 'Processed' },
        { batch_id: o1!.id, direction: 'DOWN', depth: 1, status_before: 'InTransit' },
        { batch_id: o2!.id, direction: 'DOWN', depth: 1, status_before: 'Processed' },
        { batch_id: o3.id, direction: 'DOWN', depth: 2, status_before: 'Approved' },
      ].sort((x, y) => x.depth - y.depth || (x.batch_id < y.batch_id ? -1 : 1)),
    );
    const tasks = await query(
      `SELECT batch_id, holder_org_id FROM recall_tasks WHERE recall_id = $1 ORDER BY batch_id`,
      [recallId],
    );
    expect(tasks).toEqual(
      [
        { batch_id: o1!.id, holder_org_id: retailer.orgId }, // InTransit: the receiver of the SENT waybill
        { batch_id: o3.id, holder_org_id: processor.orgId },
      ].sort((x, y) => (x.batch_id < y.batch_id ? -1 : 1)),
    );
    for (const id of [o1!.id, o3.id])
      expect((await getBatch(processor.client, id)).body.status).toBe('Recalled');
    expect((await getBatch(processor.client, o2!.id)).body.status).toBe('Processed');
    const notes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.payload.labTestId === t1.id);
    // An unplanned test also notifies the inspectors; holder ≠ origin → both organizations.
    expect(notes[0]!.recipients).toEqual({
      userIds: [],
      orgIds: [farm.orgId, processor.orgId],
      orgHeadIds: [],
      roles: ['INSPECTOR'],
    });

    // A second FAIL on the same source joins the OPEN recall: same id, no new recall.requested.
    const t2 = await assign(a.id);
    const since2 = await dbNow();
    const r2 = await submit(lab, t2.id, 1, fail(t2));
    expect(r2.status, r2.text).toBe(200);
    expect(r2.body.recallId).toBe(recallId);
    expect(
      (await query(`SELECT count(*)::int AS n FROM recalls WHERE source_batch_id = $1`, [a.id]))[0]!.n,
    ).toBe(1);
    expect(
      (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since: since2 })).filter(
        (e) => e.payload.data.sourceBatchId === a.id,
      ),
    ).toEqual([]);

    // O2 (Processed) whose only child O3 is already Recalled: no task → CLOSED at once, closed_at = opened_at, v2.
    const t3 = await assign(o2!.id);
    const since3 = await dbNow();
    const r3 = await submit(lab, t3.id, 1, fail(t3));
    expect(r3.status, r3.text).toBe(200);
    const closedId = r3.body.recallId as string;
    expect(closedId).not.toBe(recallId);
    const [closed] = await query(`SELECT status, opened_at, closed_at, version FROM recalls WHERE id = $1`, [
      closedId,
    ]);
    expect(closed).toMatchObject({ status: 'CLOSED', version: 2 });
    expect(closed!.closed_at).toEqual(closed!.opened_at);
    expect((await query(`SELECT 1 FROM recall_tasks WHERE recall_id = $1`, [closedId])).length).toBe(0);
    expect(
      (
        await query(`SELECT status_before FROM recall_batches WHERE recall_id = $1 ORDER BY depth`, [
          closedId,
        ])
      ).map((r) => r.status_before),
    ).toEqual(['Processed', 'Recalled']);
    const closeNotes = (
      await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since: since3 })
    )
      .map((e) => e.payload.data)
      .filter((d) => d.notificationType === 'RECALL' && d.payload.recallId === closedId);
    expect(closeNotes).toEqual([
      {
        notificationType: 'RECALL',
        recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          recallId: closedId,
          event: 'CLOSED',
          sourceBatchId: o2!.id,
          publicCode: o2!.publicCode,
          trigger: 'LAB',
        },
      },
    ]);
    // recall.requested is still written (rating, R89: its handler sends no OPENED for a closed recall).
    expect(
      (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since: since3 })).filter(
        (e) => e.payload.data.recallId === closedId,
      ).length,
    ).toBe(1);
    // The origin of O2 is a processor: no rating.recalculate for this FAIL.
    expect(
      (await outboxEvents({ backend: BACKEND, type: 'rating.recalculate', since: since3 })).filter(
        (e) => e.payload.data.sourceId === t3.id,
      ),
    ).toEqual([]);
  });

  it('a batch recalled while on test: the result is recorded, the batch keeps Recalled; FAIL joins its OPEN recall', async () => {
    const first = await onTest();
    // Two tests of one batch: an inspector test added to the RISK test, then the RISK test fails.
    const extra = await createTest(inspector, { batchId: first.batch.id, labOrgId: first.test.lab.id });
    expect(extra.status, extra.text).toBe(201);
    const r1 = await submit(
      first.lab,
      first.test.id,
      1,
      valuesOf(first.test, () => '99999'),
    );
    expect(r1.status, r1.text).toBe(200);
    const r2 = await submit(
      first.lab,
      extra.body.id,
      1,
      valuesOf(first.test, () => '99999'),
    );
    expect(r2.status, r2.text).toBe(200);
    expect(r2.body.recallId).toBe(r1.body.recallId);
    expect(r2.body.batch.status).toBe('Recalled');
    // PASS on a recalled batch: no transition, no recall.
    const extra2 = await createTest(inspector, { batchId: first.batch.id, labOrgId: first.test.lab.id });
    // labSummary changes with every result: the public page is dropped even without a status change (R82).
    await redis().set(`pub:batch:${first.batch.publicCode}`, '{"stale":true}', 'EX', 300);
    const r3 = await submit(
      first.lab,
      extra2.body.id,
      1,
      valuesOf(first.test, () => '0'),
    );
    expect(r3.status, r3.text).toBe(200);
    expect(r3.body).toMatchObject({ conclusion: 'PASS', recallId: null, batch: { status: 'Recalled' } });
    expect(await redis().exists(`pub:batch:${first.batch.publicCode}`)).toBe(0);
  });

  it('two parallel FAIL results on two tests of one batch: one recall, both answers carry its id', async () => {
    const first = await onTest();
    const extra = await createTest(inspector, { batchId: first.batch.id, labOrgId: first.test.lab.id });
    expect(extra.status, extra.text).toBe(201);
    const values = valuesOf(first.test, () => '99999');
    const [a, b] = await Promise.all([
      submit(first.lab, first.test.id, 1, values),
      submit(first.lab, extra.body.id, 1, values),
    ]);
    expect(a.status, a.text).toBe(200);
    expect(b.status, b.text).toBe(200);
    expect(a.body.recallId).toBe(b.body.recallId);
    const rows = await query(`SELECT id FROM recalls WHERE source_batch_id = $1`, [first.batch.id]);
    expect(rows.map((r) => r.id)).toEqual([a.body.recallId]);
  });
});

describe('protocol (PDF ≤ 10 MiB)', () => {
  it('upload: only LAB of the test; 413 above the inclusive limit; 415 not a PDF; replacement soft-deletes the old file; version kept', async () => {
    const { test, lab, other } = await onTest();
    const pdf = fixture('document.pdf');
    expectProblem(await putProtocol(fresh.client, test.id, pdf), 403, 'FORBIDDEN', null);
    expectProblem(await putProtocol(other, test.id, pdf), 404, 'NOT_FOUND');
    expectProblem(await putProtocol(lab, test.id, pdfOfSize(PROTOCOL_MAX + 1)), 413, 'FILE_TOO_LARGE', {
      maxBytes: PROTOCOL_MAX,
    });
    expectProblem(
      await putProtocol(lab, test.id, fixture('tiny-40x20.png'), 'x.pdf'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      {
        allowed: ['application/pdf'],
      },
    );
    expectErrors(
      await (async () => {
        const r = await lab.put(`/lab-tests/${test.id}/protocol`, { file: 'x' });
        await expectContract(r, 'uploadLabProtocol');
        return r;
      })(),
      { file: ['validation.required'] },
    );
    expectProblem(await getProtocol(lab, test.id), 404, 'NOT_FOUND');

    const big = pdfOfSize(PROTOCOL_MAX);
    const first = await putProtocol(lab, test.id, big, 'протокол-1.pdf');
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({
      mime: 'application/pdf',
      sizeBytes: PROTOCOL_MAX,
      originalName: 'протокол-1.pdf',
    });
    const card = (await getTest(lab, test.id)).body as LabTest;
    expect(card).toMatchObject({ hasProtocol: true, version: 1, protocol: { id: first.body.id } });

    const second = await putProtocol(lab, test.id, pdf, 'protokol-2.pdf');
    expect(second.status, second.text).toBe(200);
    const anon = api();
    expectProblem(await anon.get(apiPath(first.body.url)), 404, 'NOT_FOUND');
    const signed = await anon.get(apiPath(second.body.url));
    expect(signed.status).toBe(200);
    expect(signed.bytes.equals(pdf)).toBe(true);
    expect((await getTest(lab, test.id)).body).toMatchObject({
      version: 1,
      protocol: { id: second.body.id },
    });
    const audit = await auditEntries({ action: 'uploadLabProtocol', entityId: test.id });
    expect(audit.length).toBe(2);
  });

  it('download: whoever sees the test; inline with originalName, ETag, 304; 404 without a protocol or visibility', async () => {
    const { test, lab, other } = await onTest();
    const pdf = fixture('document.pdf');
    expect((await putProtocol(lab, test.id, pdf, 'Протокол №5.pdf')).status).toBe(200);
    for (const c of [lab, fresh.client, inspector, admin]) {
      const res = await getProtocol(c, test.id);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe(contentDisposition('Протокол №5.pdf', 'pdf'));
      expect(res.headers.get('etag')).toBe(`"${sha256hex(pdf)}"`);
      expect(res.bytes.equals(pdf)).toBe(true);
    }
    const etag = `"${sha256hex(pdf)}"`;
    expect((await getProtocol(lab, test.id, { 'If-None-Match': etag })).status).toBe(304);
    expectProblem(await getProtocol(other, test.id), 404, 'NOT_FOUND');
    expectProblem(await getProtocol((await petrov()).client, test.id), 404, 'NOT_FOUND');
  });
});

describe('lab-escalation scheduler (BR-08 of the lab, Review Focus 4)', () => {
  it('QUEUED/SAMPLED past dueAt → ESCALATED (escalatedAt, version + 1, lab.escalate, audit); not yet due or DONE untouched', async () => {
    const q = await onTest();
    const s = await onTest();
    const notDue = await onTest();
    const done = await onTest();
    expect((await sample(s.lab, s.test.id, 1)).status).toBe(200);
    expect(
      (
        await submit(
          done.lab,
          done.test.id,
          1,
          valuesOf(done.test, () => '0'),
        )
      ).status,
    ).toBe(200);
    // Taken before the fixture writes: a tick may escalate right after the first one commits.
    const since = await dbNow();
    // Fixture write (documented time control): the due moment is moved instead of waiting 5 working days.
    await fixtureWrite(`UPDATE lab_tests SET due_at = now() - interval '1 second' WHERE id = ANY($1)`, [
      [q.test.id, s.test.id, done.test.id],
    ]);
    await fixtureWrite(`UPDATE lab_tests SET due_at = now() + interval '1 hour' WHERE id = $1`, [
      notDue.test.id,
    ]);
    // overdue is computed at read time, whether or not the scheduler has acted yet (both statuses are open).
    const before = (await getTest(q.lab, q.test.id)).body as LabTest;
    expect(['QUEUED', 'ESCALATED']).toContain(before.status);
    expect(before.overdue).toBe(true);
    const escalated = await eventually(async () => {
      const t = (await getTest(q.lab, q.test.id)).body as LabTest;
      const u = (await getTest(s.lab, s.test.id)).body as LabTest;
      return t.status === 'ESCALATED' && u.status === 'ESCALATED' ? ([t, u] as const) : undefined;
    }, 20_000);
    for (const [t, version] of [
      [escalated[0], 2],
      [escalated[1], 3],
    ] as const) {
      expect(t).toMatchObject({
        status: 'ESCALATED',
        overdue: true,
        version,
        actions: ['submitResults', 'uploadProtocol'],
      });
      expect(t.escalatedAt).not.toBeNull();
      expect(Date.parse(t.escalatedAt!)).toBeGreaterThan(Date.parse(t.dueAt));
    }
    // A later tick has certainly run by now (1 s ticks); the not-yet-due and the DONE test are untouched.
    await new Promise((r) => setTimeout(r, 2500));
    expect((await getTest(notDue.lab, notDue.test.id)).body).toMatchObject({
      status: 'QUEUED',
      version: 1,
      overdue: false,
    });
    expect((await getTest(done.lab, done.test.id)).body).toMatchObject({
      status: 'DONE',
      overdue: false,
      escalatedAt: null,
    });

    const events = (await outboxEvents({ backend: BACKEND, type: 'lab.escalate', since })).filter((e) =>
      [q.test.id, s.test.id].includes(e.payload.data.labTestId),
    );
    expect(events.length).toBe(2);
    const ev = events.find((e) => e.payload.data.labTestId === q.test.id)!;
    expect(ev.payload.requestId).toBeNull();
    expect(instants(ev.payload.data)).toEqual(
      instants({
        labTestId: q.test.id,
        labOrgId: q.test.lab.id,
        batchId: q.batch.id,
        publicCode: q.batch.publicCode,
        dueAt: escalated[0].dueAt,
        escalatedAt: escalated[0].escalatedAt,
      }),
    );
    const audit = await auditEntries({ action: 'system.labTestEscalate', entityId: q.test.id });
    expect(audit.length).toBe(1);
    expect(audit[0]!.actor).toBeNull();
    expect(audit[0]!.diff).toMatchObject({ status: ['QUEUED', 'ESCALATED'], version: [1, 2] });

    // ESCALATED: no sample, results still accepted.
    expectProblem(await sample(q.lab, q.test.id, 2), 409, 'INVALID_TRANSITION', {
      from: 'ESCALATED',
      to: 'SAMPLED',
    });
    const res = await submit(
      q.lab,
      q.test.id,
      2,
      valuesOf(q.test, () => '0'),
    );
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'DONE', overdue: false, version: 3 });
    expect((await listTests(inspector, { batchId: q.batch.id, overdue: 'true' })).body.total).toBe(0);
    expect((await listTests(inspector, { batchId: notDue.batch.id, overdue: 'false' })).body.total).toBe(2);
  });
});
