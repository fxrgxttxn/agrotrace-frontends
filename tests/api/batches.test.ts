/**
 * Batches (contracts/openapi/paths/batches.yaml; FR-PROD-03/07/08, R20, R42–R45, R49, R51, D14, D16, D18): creation
 * with the BR-03 risk model and the lab assignment (409 NO_LAB_AVAILABLE rolled back), LAB_ASSIGNED in the outbox,
 * visibility S ∪ N by role, `actions`, list filters and sorting, history, path, graph (accessible flags), QR (R43/R44,
 * stored files, regeneration, 404 before generation), sale (R20, If-Match compare-and-set), the public page cache
 * (R82: `pub:batch:{publicCode}` dropped after the commit).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { closeDb, dbNow, outboxEvents, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { apiPath, sha256hex } from './lib/files.js';
import { freshHead, setOrgStatus } from './lib/fixtures.js';
import {
  acceptWaybill,
  approvedBatch,
  createBatch,
  createWaybill,
  daysAgo,
  deliver,
  freshOrg,
  getBatch,
  newField,
  petrov,
  products,
  sentWaybill,
  wheat,
  type Farm,
} from './lib/production.js';
import { closeRedis, redis } from './lib/redis.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const UUID0 = '00000000-0000-4000-8000-000000000000';
const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

async function list(client: ApiClient, query: Record<string, string | number> = {}) {
  const res = await client.get('/batches', { query });
  await expectContract(res, 'listBatches');
  return res;
}
async function listAll(client: ApiClient, query: Record<string, string> = {}) {
  const out: { id: string; publicCode: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await list(client, { ...query, size: 100, page });
    expect(res.status, res.text).toBe(200);
    out.push(...res.body.items);
    if (out.length >= res.body.total || res.body.items.length === 0) return out;
  }
}
async function history(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}/history`);
  await expectContract(res, 'getBatchHistory');
  return res;
}
async function path(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}/path`);
  await expectContract(res, 'getBatchPath');
  return res;
}
async function graph(client: ApiClient, id: string, query: Record<string, string | number> = {}) {
  const res = await client.get(`/batches/${id}/graph`, { query });
  await expectContract(res, 'getBatchGraph');
  return res;
}
async function documents(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}/documents`);
  await expectContract(res, 'getBatchDocuments');
  return res;
}
async function createQr(client: ApiClient, id: string, body?: unknown) {
  const res = await client.post(`/batches/${id}/qr`, body);
  await expectContract(res, 'createBatchQr');
  return res;
}
async function downloadQr(
  client: ApiClient,
  id: string,
  format?: string,
  headers: Record<string, string> = {},
) {
  const res = await client.get(`/batches/${id}/qr`, { query: { format }, headers });
  await expectContract(res, 'downloadBatchQr');
  return res;
}
async function onSale(client: ApiClient, id: string, version: number | string | undefined) {
  const res = await client.post(`/batches/${id}/on-sale`, undefined, {
    headers: version === undefined ? {} : { 'If-Match': String(version) },
  });
  await expectContract(res, 'putBatchOnSale');
  return res;
}
async function sold(client: ApiClient, id: string, version: number) {
  const res = await client.post(`/batches/${id}/sold`, undefined, {
    headers: { 'If-Match': String(version) },
  });
  await expectContract(res, 'markBatchSold');
  return res;
}

let farm: Farm;
let inspector: ApiClient;
beforeAll(async () => {
  farm = await petrov();
  inspector = await loginAs('INSPECTOR');
});

/** A fresh farm (head) with a field: a NEW_FARM, so its batches go OnTest. */
async function newFarm(): Promise<Farm> {
  const h = await freshHead('FARM');
  return { client: h.client, field: await newField(h.client), orgId: h.org.organizationId };
}

describe('createBatch', () => {
  it('x-roles: only FARMER registers batches', async () => {
    const body = {
      fieldId: farm.field.id,
      productId: (await wheat()).id,
      massKg: '1.000',
      harvestedAt: daysAgo(1),
    };
    for (const role of ROLES.filter((r) => r !== 'FARMER')) {
      const res = await createBatch(await loginAs(role), body);
      expectProblem(res, 403, 'FORBIDDEN', null);
    }
    expectProblem(await createBatch(api(), body), 401, 'UNAUTHORIZED');
  });

  it('body: required fields, wire mass format, positive mass, references, harvestedAt not in the future', async () => {
    expectErrors(await createBatch(farm.client, {}), {
      fieldId: ['validation.required'],
      productId: ['validation.required'],
      massKg: ['validation.required'],
      harvestedAt: ['validation.required'],
    });
    const product = await wheat();
    const base = { fieldId: farm.field.id, productId: product.id, harvestedAt: daysAgo(1) };
    expectErrors(await createBatch(farm.client, { ...base, massKg: '12' }), {
      massKg: ['validation.mass.format'],
    });
    expectErrors(await createBatch(farm.client, { ...base, massKg: '0.000' }), {
      massKg: ['validation.positive'],
    });
    expectErrors(await createBatch(farm.client, { ...base, massKg: '1.000', extra: 1 }), {
      extra: ['validation.unknownField'],
    });
    const other = await newFarm();
    const processed = (await products()).find((p) => p.category === 'PROCESSED')!;
    expectErrors(
      await createBatch(farm.client, {
        fieldId: other.field.id,
        productId: processed.id,
        massKg: '1.000',
        harvestedAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      {
        fieldId: ['validation.notFound'],
        productId: ['validation.product.category'],
        harvestedAt: ['validation.date.future'],
      },
    );
    expectErrors(await createBatch(farm.client, { ...base, productId: UUID0, massKg: '1.000' }), {
      productId: ['validation.notFound'],
    });
  });

  it('an experienced farm: AT-YYYY-NNNNNN, RAW, holder = origin, Approved via TEST_NOT_REQUIRED, version 2, actions [ship]', async () => {
    const b = await approvedBatch(farm, { massKg: '12480.500' });
    expect(b.publicCode).toMatch(new RegExp(`^AT-${new Date().getUTCFullYear()}-\\d{6,}$`));
    expect(b).toMatchObject({
      kind: 'RAW',
      status: 'Approved',
      massKg: '12480.500',
      testRequired: false,
      testReason: 'NONE',
      version: 2,
      producedAt: null,
      qrGeneratedAt: null,
      field: { id: farm.field.id, name: farm.field.name },
      actions: [{ action: 'ship', to: 'InTransit' }],
    });
    expect(b.holder.id).toBe(farm.orgId);
    expect(b.origin.id).toBe(farm.orgId);
    const h = await history(farm.client, b.id);
    expect(h.status, h.text).toBe(200);
    expect(
      h.body.map((x: { from: string | null; to: string; reason: string }) => [x.from, x.to, x.reason]),
    ).toEqual([
      [null, 'Created', 'CREATED'],
      ['Created', 'Approved', 'TEST_NOT_REQUIRED'],
    ]);
    expect(h.body[0].changedBy.fullName).toBe('Петров Иван Сергеевич');
    expect(h.body[1].changedBy).toBeNull();
    // Audit: createBatch on the batch.
    const audit = await auditEntries({ action: 'createBatch', entityId: b.id });
    expect(audit.length).toBe(1);
    expect(audit[0]!.diff.status).toEqual([null, 'Approved']);
    expect(audit[0]!.backend).toBe(process.env.API_BACKEND ?? 'express');
  });

  it('a new farm (BR-03 NEW_FARM): OnTest, a QUEUED lab test of the least-loaded ACTIVE lab of the region (D18), LAB_ASSIGNED in the outbox', async () => {
    const fresh = await newFarm();
    const since = await dbNow();
    const res = await createBatch(fresh.client, {
      fieldId: fresh.field.id,
      productId: (await wheat()).id,
      massKg: '500.000',
      harvestedAt: daysAgo(2),
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({
      status: 'OnTest',
      testRequired: true,
      testReason: 'NEW_FARM',
      version: 2,
      actions: [],
    });
    const h = await history(fresh.client, res.body.id);
    expect(h.body.map((x: { reason: string }) => x.reason)).toEqual(['CREATED', 'TEST_REQUIRED']);
    const [test] = await query(
      `SELECT lab_org_id, reason, status, due_at, created_at FROM lab_tests WHERE batch_id = $1`,
      [res.body.id],
    );
    expect(test).toMatchObject({ reason: 'RISK', status: 'QUEUED' });
    const events = (
      await outboxEvents({
        backend: process.env.API_BACKEND ?? 'express',
        type: 'notification.dispatch',
        since,
      })
    ).filter((e) => e.payload.data.payload.batchId === res.body.id);
    expect(events.length).toBe(1);
    expect(events[0]!.payload.data).toMatchObject({
      notificationType: 'LAB_ASSIGNED',
      recipients: { userIds: [], orgHeadIds: [], roles: [] },
      payload: {
        batchId: res.body.id,
        publicCode: res.body.publicCode,
        productName: res.body.product.name,
        labOrgId: test!.lab_org_id,
        reason: 'RISK',
      },
    });
    expect([...events[0]!.payload.data.recipients.orgIds].sort()).toEqual(
      [test!.lab_org_id, fresh.orgId].sort(),
    );
    // D18 oracle: ACTIVE labs of the field's region (else all), fewest QUEUED/SAMPLED/ESCALATED tests, then id (C).
    const labs = await query<{ id: string; local: boolean; load: string }>(
      `SELECT o.id, o.region_id = (SELECT region_id FROM fields WHERE id = $1) AS local,
              (SELECT count(*) FROM lab_tests t WHERE t.lab_org_id = o.id AND t.deleted_at IS NULL
                 AND t.status IN ('QUEUED','SAMPLED','ESCALATED') AND t.batch_id <> $2) AS load
         FROM organizations o WHERE o.type = 'LAB' AND o.status = 'ACTIVE' AND o.deleted_at IS NULL`,
      [fresh.field.id, res.body.id],
    );
    const pool = labs.some((l) => l.local) ? labs.filter((l) => l.local) : labs;
    const min = Math.min(...pool.map((l) => Number(l.load)));
    const expected = pool
      .filter((l) => Number(l.load) === min)
      .map((l) => l.id)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0];
    expect(test!.lab_org_id).toBe(expected);
    // The assigned lab sees the batch (its documents too); another lab does not.
    for (const key of ['vetlab.head', 'agrotest.head']) {
      const client = await loginAs('LAB', { key });
      const me = await client.get('/me');
      const r = await getBatch(client, res.body.id);
      expect(r.status, `${key}: ${r.text}`).toBe(me.body.organization.id === test!.lab_org_id ? 200 : 404);
    }
  });

  it('no ACTIVE laboratory at all: 409 NO_LAB_AVAILABLE, nothing created, the code sequence value spent (R42)', async () => {
    const labs = await query<{ id: string }>(
      `SELECT id FROM organizations WHERE type = 'LAB' AND status = 'ACTIVE' AND deleted_at IS NULL`,
    );
    const fresh = await newFarm();
    const before = await approvedBatch(farm);
    try {
      for (const l of labs) await setOrgStatus(l.id, 'SUSPENDED');
      const res = await createBatch(fresh.client, {
        fieldId: fresh.field.id,
        productId: (await wheat()).id,
        massKg: '10.000',
        harvestedAt: daysAgo(1),
      });
      expectProblem(res, 409, 'NO_LAB_AVAILABLE', null);
      expect((await listAll(fresh.client)).length).toBe(0);
    } finally {
      for (const l of labs) await setOrgStatus(l.id, 'ACTIVE');
    }
    // The refused registration spent N+1: the next one is N+2 (suites run one at a time).
    const after = await createBatch(farm.client, {
      fieldId: farm.field.id,
      productId: (await wheat()).id,
      massKg: '10.000',
      harvestedAt: daysAgo(1),
    });
    expect(after.status, after.text).toBe(201);
    const n = (code: string) => Number(code.split('-')[2]);
    expect(n(after.body.publicCode) - n(before.publicCode)).toBe(2);
  });
});

describe('visibility (tag Batches, D14) and actions', () => {
  it('another farm, an unrelated processor and a LAB without a test of the batch see 404 everywhere; INSPECTOR and ADMIN see it', async () => {
    const b = await approvedBatch(farm);
    const strangers = [(await newFarm()).client, (await freshOrg('PROCESSOR')).client];
    for (const client of strangers) {
      expectProblem(await getBatch(client, b.id), 404, 'NOT_FOUND');
      expectProblem(await history(client, b.id), 404, 'NOT_FOUND');
      expectProblem(await path(client, b.id), 404, 'NOT_FOUND');
      expectProblem(await graph(client, b.id), 404, 'NOT_FOUND');
      expectProblem(await documents(client, b.id), 404, 'NOT_FOUND');
      const ids = (await listAll(client)).map((x) => x.id);
      expect(ids).not.toContain(b.id);
    }
    expectProblem(await getBatch(await loginAs('LAB'), b.id), 404, 'NOT_FOUND');
    for (const role of ['INSPECTOR', 'ADMIN'] as const) {
      const res = await getBatch(await loginAs(role), b.id);
      expect(res.status, res.text).toBe(200);
      expect(res.body.actions).toEqual(role === 'INSPECTOR' ? [{ action: 'recall', to: 'Recalled' }] : []);
    }
    expectProblem(await getBatch(farm.client, UUID0), 404, 'NOT_FOUND');
    expectErrors(await getBatch(farm.client, 'not-a-uuid'), { id: ['validation.uuid'] });
  });

  it('the receiver of a SENT waybill sees the batch with accept/reject; a DRAFT gives no visibility', async () => {
    const processor = await freshOrg('PROCESSOR');
    const draftOnly = await approvedBatch(farm);
    const d = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: draftOnly.id, massDeclaredKg: draftOnly.massKg }],
    });
    expect(d.status, d.text).toBe(201);
    expectProblem(await getBatch(processor.client, draftOnly.id), 404, 'NOT_FOUND');

    const b = await approvedBatch(farm);
    await sentWaybill(farm.client, processor.orgId, [b]);
    const seen = await getBatch(processor.client, b.id);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.body.status).toBe('InTransit');
    expect(seen.body.holder.id).toBe(farm.orgId);
    expect(seen.body.actions).toEqual([
      { action: 'accept', to: 'Accepted' },
      { action: 'reject', to: 'Approved' },
    ]);
    // The sender (holder in transit) has nothing to do with an InTransit batch.
    expect((await getBatch(farm.client, b.id)).body.actions).toEqual([]);
  });

  it('N: direct parents of a held batch are visible, grandparents are not; graph `accessible` agrees with getBatch', async () => {
    // Seeded graph: a derived batch held by a retailer, whose parent has its own parent (raw → derived → derived).
    const rows = await query<{ child: string; parent: string; grand: string; email: string }>(
      `SELECT c.id AS child, l1.parent_batch_id AS parent, l2.parent_batch_id AS grand, u.email
         FROM batches c
         JOIN organizations o ON o.id = c.holder_org_id AND o.type = 'RETAILER'
         JOIN users u ON u.organization_id = o.id AND u.is_org_admin
         JOIN batch_links l1 ON l1.child_batch_id = c.id
         JOIN batch_links l2 ON l2.child_batch_id = l1.parent_batch_id
        WHERE c.deleted_at IS NULL
        ORDER BY c.public_code, u.email LIMIT 1`,
    );
    const client = rows[0]
      ? await loginAs('RETAILER', { key: rows[0].email.split('@')[0] })
      : await loginAs('RETAILER', { key: 'provizia.head' });
    const me = (await client.get('/me')).body.organization.id as string;
    const held = rows[0]?.child ?? (await listAll(client, { holder: 'me' }))[0]!.id;
    const parents = await query<{ id: string }>(
      `SELECT parent_batch_id AS id FROM batch_links WHERE child_batch_id = $1`,
      [held],
    );
    expect(parents.length, 'the seed has a derived batch at a retailer').toBeGreaterThan(0);
    expect((await getBatch(client, held)).status).toBe(200);
    for (const p of parents) expect((await getBatch(client, p.id)).status, `parent ${p.id}`).toBe(200);
    if (rows[0]) {
      // The grandparent is only N of N: visible only if the retailer is in S of it (origin, holder, its waybills).
      const s = await query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM batches b WHERE b.id = $1 AND $2 IN (b.origin_org_id, b.holder_org_id))
             OR EXISTS (SELECT 1 FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
                         WHERE wi.batch_id = $1 AND w.deleted_at IS NULL AND w.status <> 'DRAFT'
                           AND $2 IN (w.sender_org_id, w.receiver_org_id)) AS ok`,
        [rows[0].grand, me],
      );
      if (!s[0]!.ok) expect((await getBatch(client, rows[0].grand)).status).toBe(404);
    }
    const g = await graph(client, held, { depth: 5 });
    expect(g.status, g.text).toBe(200);
    for (const node of g.body.nodes as { id: string; accessible: boolean }[]) {
      const res = await getBatch(client, node.id);
      expect(res.status === 200, `${node.id} accessible=${node.accessible}`).toBe(node.accessible);
    }
  });
});

describe('listBatches filters and sorting (R49, R51)', () => {
  it('orgId only for INSPECTOR/ADMIN (validation.orgId.notAllowed otherwise); origin/holder = me; status, kind, q, from/to; x-sort', async () => {
    expectErrors(await list(farm.client, { orgId: farm.orgId }), { orgId: ['validation.orgId.notAllowed'] });
    expectErrors(await list(farm.client, { sort: 'version,asc' }), { sort: ['validation.sort'] });
    expectErrors(await list(farm.client, { status: 'Nope' }), { status: ['validation.enum'] });
    expectErrors(await list(farm.client, { from: '2026-09-02', to: '2026-09-01' }), {
      from: ['validation.range'],
    });

    const b = await approvedBatch(farm, { harvestedAt: '2026-03-03T10:00:00Z' });
    const mine = await listAll(farm.client, { origin: 'me' });
    expect(mine.map((x) => x.id)).toContain(b.id);
    for (const x of mine as unknown as { origin: { id: string } }[]) expect(x.origin.id).toBe(farm.orgId);
    for (const x of (await listAll(farm.client, { holder: 'me' })) as unknown as { holder: { id: string } }[])
      expect(x.holder.id).toBe(farm.orgId);

    const byOrg = await listAll(inspector, { orgId: farm.orgId });
    expect(byOrg.map((x) => x.id)).toContain(b.id);
    for (const x of byOrg as unknown as { origin: { id: string }; holder: { id: string } }[])
      expect([x.origin.id, x.holder.id]).toContain(farm.orgId);
    expect((await list(inspector, { holder: 'me' })).body.total).toBe(0);
    expect((await list(inspector, { origin: 'me' })).body.total).toBe(0);

    const day = await listAll(farm.client, {
      from: '2026-03-03',
      to: '2026-03-03',
      status: 'Approved',
      kind: 'RAW',
    });
    expect(day.map((x) => x.id)).toContain(b.id);
    for (const x of day as unknown as { harvestedAt: string; status: string }[]) {
      expect(x.harvestedAt.slice(0, 10)).toBe('2026-03-03');
      expect(x.status).toBe('Approved');
    }
    const q = await list(farm.client, { q: b.publicCode.toLowerCase() });
    expect(q.body.items.map((x: { id: string }) => x.id)).toEqual([b.id]);

    const sorted = await list(inspector, { sort: 'publicCode,asc', size: 100 });
    const codes = sorted.body.items.map((x: { publicCode: string }) => x.publicCode);
    expect(codes).toEqual([...codes].sort());
    const multi = await listAll(inspector, { status: 'Sold' });
    const multi2 = await list(inspector, { size: 100 });
    void multi2;
    for (const x of multi as unknown as { status: string }[]) expect(x.status).toBe('Sold');
    const both = await inspector.get('/batches?status=Sold&status=OnSale&size=100');
    await expectContract(both, 'listBatches');
    for (const x of both.body.items) expect(['Sold', 'OnSale']).toContain(x.status);
    expectErrors(await inspector.get('/batches?status=Sold&status=Sold'), {
      status: ['validation.duplicate'],
    });
  });
});

describe('getBatchPath (R45) and getBatchGraph (D16)', () => {
  it('path: the origin from harvestedAt, each ACCEPTED waybill opens the receiver stage', async () => {
    const harvestedAt = daysAgo(3);
    const b = await approvedBatch(farm, { harvestedAt });
    const p0 = await path(farm.client, b.id);
    expect(p0.status, p0.text).toBe(200);
    expect(p0.body).toEqual([
      { org: b.origin, from: new Date(harvestedAt).toISOString(), to: null, waybillNumber: null },
    ]);
    const processor = await freshOrg('PROCESSOR');
    const wb = await deliver(farm.client, processor, b);
    const p1 = await path(processor.client, b.id);
    expect(p1.body.length).toBe(2);
    expect(p1.body[0]).toMatchObject({ org: { id: farm.orgId }, to: wb.acceptedAt, waybillNumber: null });
    expect(p1.body[1]).toMatchObject({
      org: { id: processor.orgId },
      from: wb.acceptedAt,
      to: null,
      waybillNumber: wb.number,
    });
  });

  it('graph: depth 1..5 (validation.range otherwise), nodes by depth then publicCode, edges between nodes', async () => {
    const [root] = await query<{ id: string }>(
      `SELECT b.id FROM batches b WHERE EXISTS (SELECT 1 FROM batch_links l WHERE l.parent_batch_id = b.id)
          AND EXISTS (SELECT 1 FROM batch_links l WHERE l.child_batch_id = b.id) ORDER BY b.public_code LIMIT 1`,
    );
    const anyRoot =
      root?.id ??
      (await query<{ id: string }>(`SELECT parent_batch_id AS id FROM batch_links ORDER BY 1 LIMIT 1`))[0]!
        .id;
    for (const bad of ['0', '6', '1.5', 'x'])
      expectErrors(await graph(inspector, anyRoot, { depth: bad }), { depth: ['validation.range'] });
    const g1 = await graph(inspector, anyRoot, { depth: 1 });
    const g5 = await graph(inspector, anyRoot, { depth: 5 });
    const gd = await graph(inspector, anyRoot);
    expect(gd.body.depth).toBe(2);
    for (const g of [g1, g5, gd]) {
      expect(g.status, g.text).toBe(200);
      const nodes = g.body.nodes as { id: string; depth: number; publicCode: string; accessible: boolean }[];
      expect(nodes.filter((n) => n.depth === 0).map((n) => n.id)).toEqual([anyRoot]);
      const ordered = [...nodes].sort(
        (a, b) =>
          a.depth - b.depth || (a.publicCode < b.publicCode ? -1 : a.publicCode > b.publicCode ? 1 : 0),
      );
      expect(nodes.map((n) => n.id)).toEqual(ordered.map((n) => n.id));
      expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
      for (const n of nodes) {
        expect(Math.abs(n.depth)).toBeLessThanOrEqual(g.body.depth);
        expect(n.accessible).toBe(true);
      }
      const at = new Map(nodes.map((n) => [n.id, n.depth]));
      for (const e of g.body.edges as { parent: string; child: string }[]) {
        expect(at.has(e.parent) && at.has(e.child)).toBe(true);
      }
      // No siblings: every node except the root is reached from the previous level in its direction.
      for (const n of nodes.filter((x) => x.depth !== 0)) {
        const linked = (g.body.edges as { parent: string; child: string }[]).some((e) =>
          n.depth > 0
            ? e.child === n.id && at.get(e.parent) === n.depth - 1
            : e.parent === n.id && at.get(e.child) === n.depth + 1,
        );
        expect(linked, `node ${n.publicCode} at depth ${n.depth}`).toBe(true);
      }
    }
    const ids1 = new Set(g1.body.nodes.map((n: { id: string }) => n.id));
    for (const n of gd.body.nodes) if (Math.abs(n.depth) <= 1) expect(ids1.has(n.id)).toBe(true);
  });
});

describe('QR (R43, R44)', () => {
  let retailer: { client: ApiClient; orgId: string };
  let batch: { id: string; publicCode: string; massKg: string };
  beforeAll(async () => {
    retailer = await freshOrg('RETAILER');
    batch = await approvedBatch(farm);
    await deliver(farm.client, retailer, batch);
  });

  it('x-roles PROCESSOR, RETAILER; GET before generation → 404; format required', async () => {
    for (const role of ['FARMER', 'LAB', 'INSPECTOR', 'ADMIN'] as const) {
      expectProblem(await createQr(await loginAs(role), batch.id), 403, 'FORBIDDEN', null);
      expectProblem(await downloadQr(await loginAs(role), batch.id, 'png'), 403, 'FORBIDDEN', null);
    }
    expectProblem(await downloadQr(retailer.client, batch.id, 'png'), 404, 'NOT_FOUND');
    expectErrors(await downloadQr(retailer.client, batch.id), { format: ['validation.required'] });
    expectErrors(await downloadQr(retailer.client, batch.id, 'svg'), { format: ['validation.enum'] });
    expectErrors(await createQr(retailer.client, batch.id, { size: 3 }), {
      size: ['validation.unknownField'],
    });
    const docs = await documents(retailer.client, batch.id);
    expect(docs.body.qr).toBeNull();
  });

  it('generates PNG 1024×1024 and an A6 PDF, stores them, serves the same bytes; regeneration replaces the files', async () => {
    const res = await createQr(retailer.client, batch.id, {});
    expect(res.status, res.text).toBe(201);
    expect(res.body.publicUrl).toMatch(new RegExp(`/p/${batch.publicCode}$`));
    const png = await downloadQr(retailer.client, batch.id, 'png');
    expect(png.status).toBe(200);
    expect(png.contentType).toBe('image/png');
    expect(png.headers.get('content-disposition')).toBe(`inline; filename="${batch.publicCode}.png"`);
    expect(png.headers.get('etag')).toBe(`"${sha256hex(png.bytes)}"`);
    expect(png.bytes.readUInt32BE(16)).toBe(1024);
    expect(png.bytes.readUInt32BE(20)).toBe(1024);
    const pdf = await downloadQr(retailer.client, batch.id, 'pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers.get('content-disposition')).toBe(`inline; filename="${batch.publicCode}.pdf"`);
    const cached = await downloadQr(retailer.client, batch.id, 'png', {
      'If-None-Match': png.headers.get('etag')!,
    });
    expect(cached.status).toBe(304);
    // The signed URL serves the same bytes without a token.
    const signed = await api().get(apiPath(res.body.pngUrl));
    expect(signed.status).toBe(200);
    expect(sha256hex(signed.bytes)).toBe(sha256hex(png.bytes));
    const card = await getBatch(retailer.client, batch.id);
    expect(card.body.qrGeneratedAt).not.toBeNull();
    const versionBefore = card.body.version;
    const docs = await documents(retailer.client, batch.id);
    expect(docs.body.qr).toMatchObject({ publicUrl: res.body.publicUrl });
    expect((await documents(inspector, batch.id)).body.qr).toBeNull();

    const again = await createQr(retailer.client, batch.id);
    expect(again.status, again.text).toBe(201);
    expect((await api().get(apiPath(res.body.pngUrl))).status).toBe(404);
    expect((await api().get(apiPath(res.body.pdfUrl))).status).toBe(404);
    expect((await api().get(apiPath(again.body.pngUrl))).status).toBe(200);
    expect((await getBatch(retailer.client, batch.id)).body.version).toBe(versionBefore);
  });

  it('403 NOT_HOLDER for a visible batch of another holder; 403 BATCH_STATUS for a status without QR', async () => {
    const processor = await freshOrg('PROCESSOR');
    const b = await approvedBatch(farm);
    await sentWaybill(farm.client, processor.orgId, [b]);
    expectProblem(await createQr(processor.client, b.id), 403, 'FORBIDDEN', { reason: 'NOT_HOLDER' });
    expectProblem(await downloadQr(processor.client, b.id, 'pdf'), 403, 'FORBIDDEN', {
      reason: 'NOT_HOLDER',
    });
    const other = await freshOrg('RETAILER');
    expectProblem(await createQr(other.client, batch.id), 404, 'NOT_FOUND');
    // Sold: no QR.
    const r = await freshOrg('RETAILER');
    const s = await approvedBatch(farm);
    await deliver(farm.client, r, s);
    const card = (await getBatch(r.client, s.id)).body;
    const on = await onSale(r.client, s.id, card.version);
    const done = await sold(r.client, s.id, on.body.version);
    expect(done.status, done.text).toBe(200);
    expectProblem(await createQr(r.client, s.id), 403, 'FORBIDDEN', {
      reason: 'BATCH_STATUS',
      status: 'Sold',
    });
  });
});

describe('putBatchOnSale / markBatchSold (R20, If-Match)', () => {
  it('only the RETAILER holder, from Accepted; If-Match compare-and-set; history ON_SALE/SOLD; the public page cache dropped', async () => {
    const retailer = await freshOrg('RETAILER');
    const b = await approvedBatch(farm);
    expectProblem(await onSale(farm.client, b.id, 2), 403, 'FORBIDDEN', null);
    await sentWaybill(farm.client, retailer.orgId, [b]);
    // Visible (receiver of SENT), not the holder yet.
    expectProblem(await onSale(retailer.client, b.id, 3), 403, 'FORBIDDEN', { reason: 'NOT_HOLDER' });
    const wb = (await retailer.client.get('/waybills', { query: { direction: 'incoming' } })).body.items[0];
    const acc = await acceptWaybill(retailer.client, wb, [{ batchId: b.id, massActualKg: b.massKg }]);
    expect(acc.status, acc.text).toBe(200);
    const card = (await getBatch(retailer.client, b.id)).body;
    expect(card.status).toBe('Accepted');
    expect(card.actions).toEqual([{ action: 'putOnSale', to: 'OnSale' }]);

    expectErrors(await onSale(retailer.client, b.id, undefined), { 'If-Match': ['validation.required'] });
    expectErrors(await onSale(retailer.client, b.id, 'W/"3"'), { 'If-Match': ['validation.type'] });
    expectErrors(await onSale(retailer.client, b.id, '0'), { 'If-Match': ['validation.min'] });
    expectProblem(await onSale(retailer.client, b.id, card.version - 1), 409, 'VERSION_CONFLICT', {
      currentVersion: card.version,
    });
    await redis().set(`pub:batch:${b.publicCode}`, '{"stale":true}', 'EX', 300);
    const on = await onSale(retailer.client, b.id, card.version);
    expect(on.status, on.text).toBe(200);
    expect(on.body).toMatchObject({
      status: 'OnSale',
      version: card.version + 1,
      actions: [{ action: 'sell', to: 'Sold' }],
    });
    expect(await redis().exists(`pub:batch:${b.publicCode}`)).toBe(0);
    expectProblem(await onSale(retailer.client, b.id, on.body.version), 409, 'INVALID_TRANSITION', {
      from: 'OnSale',
      to: 'OnSale',
    });
    await redis().set(`pub:batch:${b.publicCode}`, '{"stale":true}', 'EX', 300);
    const done = await sold(retailer.client, b.id, on.body.version);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ status: 'Sold', version: card.version + 2, actions: [] });
    expect(done.body.holder.id).toBe(retailer.orgId);
    expect(await redis().exists(`pub:batch:${b.publicCode}`)).toBe(0);
    expectProblem(await sold(retailer.client, b.id, done.body.version), 409, 'INVALID_TRANSITION', {
      from: 'Sold',
      to: 'Sold',
    });
    const h = (await history(retailer.client, b.id)).body as {
      reason: string;
      changedBy: { fullName: string } | null;
    }[];
    expect(h.slice(-2).map((x) => x.reason)).toEqual(['ON_SALE', 'SOLD']);
    expect(h.at(-1)!.changedBy).not.toBeNull();
    const audit = await auditEntries({ action: 'markBatchSold', entityId: b.id });
    expect(audit[0]!.diff.status).toEqual(['OnSale', 'Sold']);
  });
});
