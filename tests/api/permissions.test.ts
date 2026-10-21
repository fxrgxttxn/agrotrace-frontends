/**
 * Permission matrix (Task 14, Review Focus 2), generated from the bundled contract — never from a hand list:
 *
 * - every operation not `PUBLIC`: no token → 401 UNAUTHORIZED;
 * - every role outside `x-roles` (unless `ANY`): the demo organization head of that role → 403 FORBIDDEN without
 *   `params`; with `x-org-admin`, an employee (not a head) of every allowed role except ADMIN → 403 as well;
 * - every allowed role (heads; employees too unless `x-org-admin`, where the ADMIN employee must pass) gets past the
 *   access checks: anything but 401/403;
 * - every `PUBLIC` operation answers without a token (no 401/403);
 * - a resource of a foreign organization → 404 NOT_FOUND (never 403, never 200), on a representative set of
 *   operations: reads on seed data, writes on fresh fixtures.
 *
 * No probe changes shared seed state: the contract's check order (info.description) puts 401 and 403 by role before
 * `Idempotency-Key`, the schema (400) and the lookup (404), so a probe of an allowed role carries a random id, an
 * invalid body (`[]` → 400 `_root`) or misses a required header, and is rejected before any write. The two
 * operations of the current user without any input (deleteMyAvatar, createTelegramCode) are proved with a fresh user.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoUsers, loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient, type ApiResponse } from './lib/client.js';
import { contract, expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { fixture, upload } from './lib/files.js';
import { freshHead } from './lib/fixtures.js';
import { createWaybill, freshOrg, idemKey, sentWaybill } from './lib/production.js';
import { createRecall, freshFarm, inspector, inspectorTest, labApproved, rawBatch } from './lib/quality.js';
import { openStream } from './lib/sse.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped OpenAPI JSON
type Json = Record<string, any>;

const ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const c = await contract();

function resolve(node: Json): Json {
  let n = node;
  while (n && typeof n.$ref === 'string')
    n = n.$ref
      .slice(2)
      .split('/')
      .map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((a: Json, k: string) => a[k], c.doc);
  return n;
}

// ── the generated matrix ────────────────────────────────────────────────────────────────────────────────────────

interface Probe {
  method: string;
  path: string;
  body?: unknown;
}

/** Path params never resolving to an entity: random uuid, the first enum value, a well-formed unknown public code. */
const PATH_OVERRIDES: Record<string, string> = {
  // x-report-access (type → roles) is checked after the type enum and before the parameters: an unknown type is a
  // 400 for every role allowed by x-roles, while a real type may answer 403 by report type.
  downloadReport: '/reports/no-such-report',
};

function probeOf(id: string): Probe {
  const op = c.ops.get(id)!;
  const item = c.doc.paths[op.path] as Json;
  const params = [...(item.parameters ?? []), ...(op.op.parameters ?? [])].map(resolve);
  const path =
    PATH_OVERRIDES[id] ??
    op.path.replace(/\{([^}]+)\}/g, (_m: string, name: string) => {
      const schema = resolve(params.find((p) => p.in === 'path' && p.name === name)?.schema ?? {});
      if (Array.isArray(schema.enum)) return String(schema.enum[0]);
      if (schema.format === 'uuid') return randomUUID();
      if (name === 'publicCode') return 'AT-2099-999999';
      throw new Error(`${id}: no probe value for path param ${name}`);
    });
  const rb = op.op.requestBody ? resolve(op.op.requestBody) : null;
  // A JSON body of the wrong type (an array): 400 `_root` validation.type for every JSON operation.
  const body = rb?.required && rb.content['application/json'] ? [] : undefined;
  return { method: op.method, path, body };
}

const send = (client: ApiClient, p: Probe): Promise<ApiResponse> =>
  client.request(p.method, p.path, p.body === undefined ? {} : { body: p.body });

const sessions = new Map<string, Promise<ApiClient>>();
function session(role: Role, head: boolean): Promise<ApiClient> {
  const key = `${role}:${head}`;
  if (!sessions.has(key)) sessions.set(key, loginAs(role, { head }));
  return sessions.get(key)!;
}

let freshUser: Promise<ApiClient> | null = null;
const fresh = () => (freshUser ??= freshHead('FARM').then((h) => h.client));

/** Operations of the current user with no input to reject: proved with a fresh user, never a demo one. */
const NO_REJECTING_INPUT = new Set(['deleteMyAvatar', 'createTelegramCode']);

let requests = 0;
let cases = 0;
const started = Date.now();

async function expectDenied(res: ApiResponse, id: string, who: string, status: 401 | 403) {
  requests++;
  await expectContract(res, id);
  const code = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
  expect({ status: res.status, code: res.body?.code }, `${id} as ${who}: ${res.text}`).toEqual({
    status,
    code,
  });
  if (status === 403) expect(res.body.params, `${id} as ${who}: 403 by role has no params`).toBeUndefined();
}

async function expectAllowed(res: ApiResponse, id: string, who: string) {
  requests++;
  await expectContract(res, id);
  expect([401, 403], `${id} as ${who} must pass the access checks: ${res.status} ${res.text}`).not.toContain(
    res.status,
  );
}

const ops = [...c.ops.values()];
const isPublic = (op: Json) => (op['x-roles'] as string[]).includes('PUBLIC');

describe('permission matrix (x-roles, x-org-admin, x-access) — generated from the contract', () => {
  for (const op of ops.filter((o) => !isPublic(o.op))) {
    const id = op.operationId;
    const roles = op.op['x-roles'] as string[];
    const any = roles.includes('ANY');
    const orgAdmin = op.op['x-org-admin'] === true;
    const label = `${id} (${op.method} ${op.path}) x-roles ${roles.join(',')}${orgAdmin ? ' x-org-admin' : ''}`;
    it(label, async () => {
      cases++;
      const p = probeOf(id);
      const checks: Promise<void>[] = [];

      if (id === 'streamEvents') {
        // SSE: the token is the `access_token` query parameter (the Authorization header is ignored).
        checks.push(
          api()
            .get('/events/stream')
            .then((r) => expectDenied(r, id, 'anonymous', 401)),
        );
        for (const role of ROLES)
          checks.push(
            (async () => {
              const s = await openStream({ token: (await session(role, true)).accessToken! });
              s.close();
              await expectAllowed(s.response, id, `${role} head`);
            })(),
          );
        await Promise.all(checks);
        return;
      }

      checks.push(send(api(), p).then((r) => expectDenied(r, id, 'anonymous', 401)));
      if (!any)
        for (const role of ROLES.filter((r) => !roles.includes(r)))
          checks.push(
            (async () => expectDenied(await send(await session(role, true), p), id, `${role} head`, 403))(),
          );

      const allowed = any ? ROLES : ROLES.filter((r) => roles.includes(r));
      if (NO_REJECTING_INPUT.has(id))
        checks.push((async () => expectAllowed(await send(await fresh(), p), id, 'a fresh FARMER head'))());
      else
        for (const role of allowed) {
          checks.push(
            (async () => expectAllowed(await send(await session(role, true), p), id, `${role} head`))(),
          );
          const employee = async () => send(await session(role, false), p);
          if (!orgAdmin) checks.push((async () => expectAllowed(await employee(), id, `${role} employee`))());
          else if (role === 'ADMIN')
            // x-org-admin binds roles other than ADMIN: a platform ADMIN who is not the head passes.
            checks.push((async () => expectAllowed(await employee(), id, 'ADMIN employee'))());
          else checks.push((async () => expectDenied(await employee(), id, `${role} employee`, 403))());
        }
      await Promise.all(checks);
    });
  }

  it('the demo seed has a head and an employee of every role (the matrix needs both)', () => {
    for (const role of ROLES)
      for (const head of [true, false])
        expect(
          demoUsers.some((u) => u.roles.includes(role) && u.isOrgAdmin === head),
          `${role} ${head ? 'head' : 'employee'}`,
        ).toBe(true);
  });
});

describe('a uuid path parameter that is not a uuid → 400 errors.<param> [validation.uuid] (after the access checks)', () => {
  // Operations without a required body, header or query beyond the path: the 400 then names the path params only.
  const params = (op: Json, item: Json) =>
    [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve);
  for (const o of ops) {
    const item = c.doc.paths[o.path] as Json;
    const all = params(o.op, item);
    const uuids = all.filter((p) => p.in === 'path' && resolve(p.schema ?? {}).format === 'uuid');
    const rb = o.op.requestBody ? resolve(o.op.requestBody) : null;
    if (uuids.length === 0 || !('400' in o.op.responses) || rb?.required) continue;
    if (all.some((p) => p.in !== 'path' && p.required) || o.op['x-idempotent']) continue;
    const roles = o.op['x-roles'] as string[];
    it(`${o.operationId} (${o.method} ${o.path})`, async () => {
      cases++;
      const path = o.path.replace(/\{([^}]+)\}/g, (_m: string, name: string) => {
        const schema = resolve(all.find((p) => p.in === 'path' && p.name === name)?.schema ?? {});
        return Array.isArray(schema.enum) ? String(schema.enum[0]) : 'not-a-uuid';
      });
      const client = roles.includes('PUBLIC')
        ? api()
        : await session((roles.includes('ANY') ? 'FARMER' : roles[0]) as Role, true);
      const res = await client.request(o.method, path);
      requests++;
      await expectContract(res, o.operationId);
      expect(res.status, res.text).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
      expect(Object.keys(res.body.errors).sort(), res.text).toEqual(
        uuids.map((p) => p.name as string).sort(),
      );
      for (const p of uuids) expect(res.body.errors[p.name], res.text).toContain('validation.uuid');
    });
  }
});

describe('PUBLIC operations answer without a token', () => {
  for (const op of ops.filter((o) => isPublic(o.op))) {
    const id = op.operationId;
    it(`${id} (${op.method} ${op.path})`, async () => {
      cases++;
      if (id === 'refreshToken') {
        // The refresh token is the `at_refresh` cookie: a session without an Authorization header rotates it.
        const client = await loginAs('FARMER', { head: true });
        client.accessToken = null;
        const res = await client.post('/auth/refresh');
        requests++;
        await expectContract(res, id);
        expect(res.status, res.text).toBe(200);
        return;
      }
      await expectAllowed(await send(api(), probeOf(id)), id, 'anonymous');
    });
  }
});

// ── foreign organization → 404 ──────────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f-]{36}$/;

/** One id of a seed entity matching `sql` (read-only lib/db.ts). */
async function seedId(sql: string, params: unknown[] = []): Promise<string> {
  const [row] = await query<{ id: string }>(`${sql} ORDER BY id LIMIT 1`, params);
  if (!row || !UUID_RE.test(row.id)) throw new Error(`no seed row for: ${sql}`);
  return row.id;
}

const orgOf = async (key: string) =>
  seedId(`SELECT o.id FROM organizations o JOIN users u ON u.organization_id = o.id WHERE u.email = $1`, [
    demoUsers.find((u) => u.key === key)!.email,
  ]);

async function expectNotFound(res: ApiResponse, id: string, who: string) {
  requests++;
  await expectContract(res, id);
  expect({ status: res.status, code: res.body?.code }, `${id} as ${who}: ${res.text}`).toEqual({
    status: 404,
    code: 'NOT_FOUND',
  });
}

describe('a resource of a foreign organization → 404 NOT_FOUND', () => {
  // Fresh organizations see nothing of the seed: every seed entity is foreign to them.
  let farm: ApiClient;
  let processor: ApiClient;
  let retailer: ApiClient;
  let lab: ApiClient;
  const seed = {} as Record<
    'field' | 'batch' | 'waybill' | 'labTest' | 'protocolTest' | 'org' | 'logoOrg',
    string
  >;
  // Fixtures of a fresh farm A (writes go to these, never to seed rows).
  const a = {} as {
    orgId: string;
    userId: string;
    fieldId: string;
    treatmentId: string;
    batch: { id: string; version: number; massKg: string };
    draft: { id: string; version: number };
    sent: { id: string; version: number; items: { batch: { id: string }; massDeclaredKg: string }[] };
    labTest: { id: string; version: number; norms: { indicatorId: string }[] };
    task: { id: string; version: number };
  };

  beforeAll(async () => {
    [farm, processor, retailer, lab] = await Promise.all([
      freshHead('FARM').then((h) => h.client),
      freshHead('PROCESSOR').then((h) => h.client),
      freshHead('RETAILER').then((h) => h.client),
      freshHead('LAB').then((h) => h.client),
    ]);
    seed.field = await seedId('SELECT id FROM fields WHERE deleted_at IS NULL');
    seed.batch = await seedId('SELECT id FROM batches WHERE deleted_at IS NULL');
    seed.waybill = await seedId(`SELECT id FROM waybills WHERE deleted_at IS NULL AND status <> 'DRAFT'`);
    seed.labTest = await seedId('SELECT id FROM lab_tests WHERE deleted_at IS NULL');
    seed.protocolTest = await seedId(
      'SELECT id FROM lab_tests WHERE deleted_at IS NULL AND protocol_file_id IS NOT NULL',
    );
    seed.org = await seedId(`SELECT id FROM organizations WHERE deleted_at IS NULL AND status = 'ACTIVE'`);
    seed.logoOrg = await seedId(
      'SELECT id FROM organizations WHERE deleted_at IS NULL AND logo_file_id IS NOT NULL',
    );

    const A = await freshFarm();
    const me = await A.client.get('/me');
    await expectContract(me, 'getMe');
    a.orgId = A.orgId;
    a.userId = me.body.id;
    a.fieldId = A.field.id;
    const substances = await A.client.get('/dictionaries/substances', { query: { size: 1 } });
    await expectContract(substances, 'listDictionary');
    const treatment = await A.client.post(`/fields/${A.field.id}/treatments`, {
      substanceId: substances.body.items[0].id,
      dose: '1.500',
      doseUnit: 'л/га',
      appliedAt: '2026-06-02T07:00:00Z',
    });
    await expectContract(treatment, 'createTreatment');
    expect(treatment.status, treatment.text).toBe(201);
    a.treatmentId = treatment.body.id;

    // Two Approved batches: one shipped to a fresh processor (SENT), one in a DRAFT waybill to the same processor.
    const p = await freshOrg('PROCESSOR');
    const shipped = await labApproved(A);
    a.batch = await labApproved(A);
    a.sent = await sentWaybill(A.client, p.orgId, [shipped]);
    const draft = await createWaybill(A.client, {
      receiverOrgId: p.orgId,
      items: [{ batchId: a.batch.id, massDeclaredKg: a.batch.massKg }],
    });
    expect(draft.status, draft.text).toBe(201);
    a.draft = draft.body;

    // A lab test of the seeded laboratory on a third batch of A, and a recall of A's batch (a task for A).
    a.labTest = await inspectorTest((await rawBatch(A)).id);
    const recall = await createRecall(await inspector(), {
      sourceBatchId: a.batch.id,
      reason: 'Проверка видимости задач',
      blockUpstream: false,
    });
    expect(recall.status, recall.text).toBe(201);
    const [task] = await query<{ id: string; version: number }>(
      'SELECT id, version FROM recall_tasks WHERE recall_id = $1 ORDER BY id LIMIT 1',
      [recall.body.id],
    );
    expect(task, 'the recall has a task for farm A').toBeDefined();
    a.task = task!;
  }, 120_000);

  afterAll(closeDb);

  it('seed reads by fresh organizations of every participant role', async () => {
    cases++;
    const reads: [ApiClient, string, string, string][] = [];
    for (const [who, client] of [
      ['fresh FARMER', farm],
      ['fresh PROCESSOR', processor],
      ['fresh RETAILER', retailer],
      ['fresh LAB', lab],
    ] as const) {
      reads.push(
        [client, who, 'getBatch', `/batches/${seed.batch}`],
        [client, who, 'getBatchGraph', `/batches/${seed.batch}/graph`],
        [client, who, 'getBatchHistory', `/batches/${seed.batch}/history`],
        [client, who, 'getBatchPath', `/batches/${seed.batch}/path`],
        [client, who, 'getBatchDocuments', `/batches/${seed.batch}/documents`],
        [client, who, 'getLabTest', `/lab-tests/${seed.labTest}`],
        [client, who, 'downloadLabProtocol', `/lab-tests/${seed.protocolTest}/protocol`],
        [client, who, 'getOrganization', `/organizations/${seed.org}`],
        [client, who, 'getOrganizationLogo', `/organizations/${seed.logoOrg}/logo`],
      );
      if (who !== 'fresh LAB') reads.push([client, who, 'getWaybill', `/waybills/${seed.waybill}`]);
    }
    reads.push(
      [farm, 'fresh FARMER', 'getField', `/fields/${seed.field}`],
      [farm, 'fresh FARMER', 'listFieldTreatments', `/fields/${seed.field}/treatments`],
    );
    for (const [client, who, id, path] of reads) await expectNotFound(await client.get(path), id, who);
  });

  it('seed reads by seeded organizations: a foreign field, lab test and waybill', async () => {
    cases++;
    const zarya = await orgOf('zarya.head');
    const vetlab = await orgOf('vetlab.head');
    const lavka = await orgOf('lavka.head');
    const field = await seedId('SELECT id FROM fields WHERE deleted_at IS NULL AND organization_id <> $1', [
      zarya,
    ]);
    const test = await seedId('SELECT id FROM lab_tests WHERE deleted_at IS NULL AND lab_org_id <> $1', [
      vetlab,
    ]);
    const batch = await seedId(
      `SELECT id FROM batches b WHERE deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM lab_tests t WHERE t.batch_id = b.id AND t.lab_org_id = $1 AND t.deleted_at IS NULL)`,
      [vetlab],
    );
    const waybill = await seedId(
      `SELECT id FROM waybills WHERE deleted_at IS NULL AND status <> 'DRAFT'
         AND sender_org_id <> $1 AND receiver_org_id <> $1`,
      [lavka],
    );
    const zaryaHead = await loginAs('FARMER', { key: 'zarya.head' });
    const vetlabHead = await loginAs('LAB', { key: 'vetlab.head' });
    const lavkaHead = await loginAs('RETAILER', { key: 'lavka.head' });
    await expectNotFound(await zaryaHead.get(`/fields/${field}`), 'getField', 'zarya.head');
    await expectNotFound(await vetlabHead.get(`/lab-tests/${test}`), 'getLabTest', 'vetlab.head');
    await expectNotFound(await vetlabHead.get(`/batches/${batch}`), 'getBatch', 'vetlab.head');
    await expectNotFound(await lavkaHead.get(`/waybills/${waybill}`), 'getWaybill', 'lavka.head');
  });

  it('writes on the fixtures of a foreign farm (valid bodies, so only visibility can refuse them)', async () => {
    cases++;
    const ifMatch = (v: number) => ({ 'If-Match': String(v) });
    const idem = () => ({ 'Idempotency-Key': idemKey() });
    const png = { data: fixture('tiny-40x20.png'), filename: 'logo.png', contentType: 'image/png' };
    const pdf = { data: fixture('document.pdf'), filename: 'protocol.pdf', contentType: 'application/pdf' };
    const writes: [string, string, () => Promise<ApiResponse>][] = [
      [
        'updateField',
        'fresh FARMER',
        () => farm.put(`/fields/${a.fieldId}`, { name: 'Чужое поле', areaHa: '1.00', regionCode: '33' }),
      ],
      ['deleteField', 'fresh FARMER', () => farm.delete(`/fields/${a.fieldId}`)],
      [
        'createTreatment',
        'fresh FARMER',
        () =>
          farm.post(`/fields/${a.fieldId}/treatments`, {
            substanceId: randomUUID(),
            dose: '1.000',
            doseUnit: 'л/га',
            appliedAt: '2026-06-02T07:00:00Z',
          }),
      ],
      [
        'deleteWaybill',
        'fresh FARMER',
        () => farm.delete(`/waybills/${a.draft.id}`, { headers: ifMatch(a.draft.version) }),
      ],
      [
        'sendWaybill',
        'fresh FARMER',
        () =>
          farm.post(`/waybills/${a.draft.id}/send`, undefined, {
            headers: { ...ifMatch(a.draft.version), ...idem() },
          }),
      ],
      [
        'retryBatchVsdImport',
        'fresh FARMER',
        () => farm.post(`/batches/${a.batch.id}/documents/vsd/retry`, undefined, { headers: idem() }),
      ],
      ['updateUser', 'fresh FARMER head', () => farm.patch(`/users/${a.userId}`, { status: 'BLOCKED' })],
      [
        'uploadOrganizationLogo',
        'fresh FARMER head',
        () => upload(farm, `/organizations/${a.orgId}/logo`, png),
      ],
      [
        'acceptWaybill',
        'fresh RETAILER',
        () =>
          retailer.post(
            `/waybills/${a.sent.id}/accept`,
            { items: a.sent.items.map((i) => ({ batchId: i.batch.id, massActualKg: i.massDeclaredKg })) },
            { headers: { ...ifMatch(a.sent.version), ...idem() } },
          ),
      ],
      [
        'rejectWaybill',
        'fresh RETAILER',
        () =>
          retailer.post(
            `/waybills/${a.sent.id}/reject`,
            { reason: 'Чужая накладная' },
            {
              headers: ifMatch(a.sent.version),
            },
          ),
      ],
      ['createBatchQr', 'fresh PROCESSOR', () => processor.post(`/batches/${a.batch.id}/qr`)],
      [
        'downloadBatchQr',
        'fresh PROCESSOR',
        () => processor.get(`/batches/${a.batch.id}/qr`, { query: { format: 'png' } }),
      ],
      [
        'putBatchOnSale',
        'fresh RETAILER',
        () =>
          retailer.post(`/batches/${a.batch.id}/on-sale`, undefined, { headers: ifMatch(a.batch.version) }),
      ],
      [
        'markBatchSold',
        'fresh RETAILER',
        () => retailer.post(`/batches/${a.batch.id}/sold`, undefined, { headers: ifMatch(a.batch.version) }),
      ],
      [
        'registerLabSample',
        'fresh LAB',
        () =>
          lab.post(`/lab-tests/${a.labTest.id}/sample`, undefined, { headers: ifMatch(a.labTest.version) }),
      ],
      [
        'submitLabResults',
        'fresh LAB',
        () =>
          lab.post(
            `/lab-tests/${a.labTest.id}/results`,
            { results: a.labTest.norms.map((n) => ({ indicatorId: n.indicatorId, value: '0' })) },
            { headers: ifMatch(a.labTest.version) },
          ),
      ],
      ['uploadLabProtocol', 'fresh LAB', () => upload(lab, `/lab-tests/${a.labTest.id}/protocol`, pdf)],
      [
        'confirmRecallTask',
        'fresh FARMER',
        () =>
          farm.post(`/recall-tasks/${a.task.id}/confirm`, undefined, {
            headers: { ...ifMatch(a.task.version), ...idem() },
          }),
      ],
    ];
    for (const [id, who, call] of writes) await expectNotFound(await call(), id, who);
  });
});

afterAll(() => {
  console.log(
    `permission matrix: ${cases} cases, ${requests} checked requests, ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
});
