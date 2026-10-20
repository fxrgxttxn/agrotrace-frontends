/**
 * Waybills (contracts/openapi/paths/waybills.yaml; R4, R47, R50, R51, R52; waybill-state-machine.json) and the
 * Idempotency-Key protocol (R48, R53): DRAFT → SENT → ACCEPTED | REJECTED, deletion of drafts only, the check orders
 * of send (D6: NOT_HOLDER → BR-06 → INVALID_TRANSITION → BR-01) and accept (BR-06 → INVALID_TRANSITION → BR-07),
 * holder and mass change on acceptance, WAYBILL_INCOMING and RECALL_TASK REASSIGNED in the outbox, recall task
 * reassignment on rejection (R50c — a batch recalled in transit by a failed lab test, Task 9), visibility,
 * idempotent replays (same answer + `Idempotent-Replayed: true`), REUSED, IN_PROGRESS + Retry-After, re-execution
 * after a 4xx, and the race of two sends over one batch (Review Focus 1: exactly one wins).
 *
 * Idempotency records are the contract's shared Redis keys `idem:{userId}:{key}` (info.description, R82): a pending
 * record is planted directly to stand in for a request still running elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { auditEntries } from './lib/audit.js';
import { expectContract } from './lib/contract.js';
import { closeDb, dbNow, outboxEvents, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import {
  acceptWaybill,
  approvedBatch,
  createWaybill,
  daysAgo,
  deliver,
  freshOrg,
  getBatch,
  idemKey,
  newField,
  petrov,
  rejectWaybill,
  sendWaybill,
  sentWaybill,
  type Farm,
} from './lib/production.js';
import { closeRedis, redis, sha256hex } from './lib/redis.js';
import { instant, instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const BACKEND = process.env.API_BACKEND ?? 'express';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function getWaybill(client: ApiClient, id: string) {
  const res = await client.get(`/waybills/${id}`);
  await expectContract(res, 'getWaybill');
  return res;
}
async function listWaybills(client: ApiClient, query: Record<string, string | number> = {}) {
  const res = await client.get('/waybills', { query });
  await expectContract(res, 'listWaybills');
  return res;
}
async function deleteWaybill(client: ApiClient, id: string, version: number | undefined) {
  const res = await client.delete(`/waybills/${id}`, {
    headers: version === undefined ? {} : { 'If-Match': String(version) },
  });
  await expectContract(res, 'deleteWaybill');
  return res;
}
async function userId(client: ApiClient): Promise<string> {
  const me = await client.get('/me');
  await expectContract(me, 'getMe');
  return me.body.id;
}

let farm: Farm;
let processor: { client: ApiClient; orgId: string; userId: string };
beforeAll(async () => {
  farm = await petrov();
  processor = await freshOrg('PROCESSOR');
});

describe('createWaybill', () => {
  it('x-roles FARMER/PROCESSOR; Idempotency-Key required and by pattern; body by schema', async () => {
    const b = await approvedBatch(farm);
    const body = { receiverOrgId: processor.orgId, items: [{ batchId: b.id, massDeclaredKg: b.massKg }] };
    for (const role of ['RETAILER', 'LAB', 'INSPECTOR', 'ADMIN'] as const)
      expectProblem(await createWaybill(await loginAs(role), body), 403, 'FORBIDDEN', null);
    const noKey = await farm.client.post('/waybills', body);
    await expectContract(noKey, 'createWaybill');
    expectProblem(noKey, 400, 'INVALID_IDEMPOTENCY_KEY');
    for (const bad of ['short', 'with space key', 'key.with.dots', 'x'.repeat(129)])
      expectProblem(await createWaybill(farm.client, body, bad), 400, 'INVALID_IDEMPOTENCY_KEY');
    // The key is checked before the body.
    expectProblem(await createWaybill(farm.client, {}, 'short'), 400, 'INVALID_IDEMPOTENCY_KEY');
    expectErrors(await createWaybill(farm.client, {}), {
      receiverOrgId: ['validation.required'],
      items: ['validation.required'],
    });
    expectErrors(await createWaybill(farm.client, { receiverOrgId: processor.orgId, items: [] }), {
      items: ['validation.minItems'],
    });
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: processor.orgId,
        items: [{ batchId: b.id, massDeclaredKg: '5' }],
      }),
      { 'items[0].massDeclaredKg': ['validation.mass.format'] },
    );
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: processor.orgId,
        items: [
          { batchId: b.id, massDeclaredKg: '1.000' },
          { batchId: b.id, massDeclaredKg: '1.000' },
        ],
      }),
      { 'items[1].batchId': ['validation.duplicate'] },
    );
    // A repeated batch is a reference error (step 2): reported in one 400 with the other reference errors.
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: UUID0,
        items: [
          { batchId: b.id, massDeclaredKg: '1.000' },
          { batchId: b.id, massDeclaredKg: '1.000' },
        ],
      }),
      { receiverOrgId: ['validation.notFound'], 'items[1].batchId': ['validation.duplicate'] },
    );
    // P36: a schema error elsewhere is reported alone (step 1) — the duplicate waits for step 2.
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: processor.orgId,
        items: [
          { batchId: b.id, massDeclaredKg: '0.000' },
          { batchId: b.id, massDeclaredKg: '1.000' },
        ],
      }),
      { 'items[0].massDeclaredKg': ['validation.positive'] },
    );
  });

  it('references in one 400: receiver not ACTIVE/type/self, invisible batch, mass above the batch; then NOT_HOLDER by request order', async () => {
    const b = await approvedBatch(farm, { massKg: '100.000' });
    const otherFarm = await freshOrg('FARM');
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: otherFarm.orgId,
        items: [
          { batchId: b.id, massDeclaredKg: '100.001' },
          { batchId: UUID0, massDeclaredKg: '1.000' },
        ],
      }),
      {
        receiverOrgId: ['validation.receiver.type'],
        'items[0].massDeclaredKg': ['validation.mass.exceedsBatch'],
        'items[1].batchId': ['validation.notFound'],
      },
    );
    expectErrors(
      await createWaybill(farm.client, {
        receiverOrgId: UUID0,
        items: [{ batchId: b.id, massDeclaredKg: '1.000' }],
      }),
      { receiverOrgId: ['validation.notFound'] },
    );
    expectErrors(
      await createWaybill(processor.client, {
        receiverOrgId: processor.orgId,
        items: [{ batchId: b.id, massDeclaredKg: '1.000' }],
      }),
      { receiverOrgId: ['validation.receiver.self'], 'items[0].batchId': ['validation.notFound'] },
    );
    // A batch the processor sees (receiver of SENT) but does not hold → 403 NOT_HOLDER {publicCode}.
    const c = await approvedBatch(farm);
    await sentWaybill(farm.client, processor.orgId, [c]);
    const retailer = await freshOrg('RETAILER');
    expectProblem(
      await createWaybill(processor.client, {
        receiverOrgId: retailer.orgId,
        items: [{ batchId: c.id, massDeclaredKg: '1.000' }],
      }),
      403,
      'FORBIDDEN',
      { reason: 'NOT_HOLDER', publicCode: c.publicCode },
    );
  });

  it('creates a DRAFT (WB-YYYY-NNNNNN, version 1, actions send/delete); batches unchanged; the receiver does not see it', async () => {
    const b = await approvedBatch(farm, { massKg: '300.000' });
    const res = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: b.id, massDeclaredKg: '250.000' }],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.number).toMatch(new RegExp(`^WB-${new Date().getUTCFullYear()}-\\d{6,}$`));
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      version: 1,
      sentAt: null,
      acceptedAt: null,
      rejectReason: null,
      actions: ['send', 'delete'],
      sender: { id: farm.orgId },
      receiver: { id: processor.orgId },
      items: [
        {
          batch: { id: b.id, status: 'Approved' },
          massDeclaredKg: '250.000',
          massActualKg: null,
          discrepancyPercent: null,
          discrepancyAct: null,
        },
      ],
    });
    expect((await getBatch(farm.client, b.id)).body.version).toBe(b.version);
    expectProblem(await getWaybill(processor.client, res.body.id), 404, 'NOT_FOUND');
    expectProblem(await getWaybill(await loginAs('INSPECTOR'), res.body.id), 404, 'NOT_FOUND');
    const own = await listWaybills(farm.client, { status: 'DRAFT', q: res.body.number });
    expect(own.body.items.map((w: { id: string }) => w.id)).toEqual([res.body.id]);
    const audit = await auditEntries({ action: 'createWaybill', entityId: res.body.id });
    expect(audit.length).toBe(1);
  });
});

describe('sendWaybill', () => {
  it('DRAFT → SENT, batches InTransit (WAYBILL_SENT), version + 1, WAYBILL_INCOMING to the receiver, cache dropped', async () => {
    const b1 = await approvedBatch(farm);
    const b2 = await approvedBatch(farm);
    const draft = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [b1, b2].map((b) => ({ batchId: b.id, massDeclaredKg: b.massKg })),
    });
    // items are ordered by publicCode.
    const codes = draft.body.items.map((i: { batch: { publicCode: string } }) => i.batch.publicCode);
    expect(codes).toEqual([...codes].sort());
    expectErrors(
      await (async () => {
        const r = await farm.client.post(`/waybills/${draft.body.id}/send`, undefined, {
          headers: { 'Idempotency-Key': idemKey() },
        });
        await expectContract(r, 'sendWaybill');
        return r;
      })(),
      { 'If-Match': ['validation.required'] },
    );
    expectProblem(
      await sendWaybill(farm.client, { id: draft.body.id, version: 7 }),
      409,
      'VERSION_CONFLICT',
      {
        currentVersion: 1,
      },
    );
    await redis().set(`pub:batch:${b1.publicCode}`, '{"stale":true}', 'EX', 300);
    const since = await dbNow();
    const res = await sendWaybill(farm.client, draft.body);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'SENT', version: 2, actions: [] });
    expect(res.body.sentAt).not.toBeNull();
    for (const it of res.body.items) {
      expect(it.batch.status).toBe('InTransit');
      expect(it.batch.holder.id).toBe(farm.orgId);
    }
    expect(await redis().exists(`pub:batch:${b1.publicCode}`)).toBe(0);
    const card = await getBatch(farm.client, b1.id);
    expect(card.body.version).toBe(b1.version + 1);
    const ev = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })).filter(
      (e) => e.payload.data.payload.waybillId === draft.body.id,
    );
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload.data).toEqual({
      notificationType: 'WAYBILL_INCOMING',
      recipients: { userIds: [], orgIds: [processor.orgId], orgHeadIds: [], roles: [] },
      payload: {
        waybillId: draft.body.id,
        number: draft.body.number,
        senderOrgId: farm.orgId,
        senderName: res.body.sender.name,
        itemsCount: 2,
      },
    });
    // The receiver now sees it, with accept/reject; INSPECTOR sees it read-only.
    const seen = await getWaybill(processor.client, draft.body.id);
    expect(seen.body.actions).toEqual(['accept', 'reject']);
    expect((await getWaybill(await loginAs('INSPECTOR'), draft.body.id)).body.actions).toEqual([]);
    // Sent again: INVALID_TRANSITION of the waybill.
    expectProblem(await sendWaybill(farm.client, res.body), 409, 'INVALID_TRANSITION', {
      from: 'SENT',
      to: 'SENT',
    });
    expectProblem(await sendWaybill(processor.client, res.body), 403, 'FORBIDDEN', { reason: 'NOT_SENDER' });
    expectProblem(await deleteWaybill(farm.client, draft.body.id, 2), 409, 'INVALID_TRANSITION', {
      from: 'SENT',
      to: 'DELETED',
    });
  });

  it('per item: INVALID_TRANSITION {from, to: InTransit, publicCode}, BR-01 {publicCode, until, substance}, NOT_HOLDER', async () => {
    const subs = await farm.client.get('/dictionaries/substances', { query: { size: 100 } });
    const pesticide = (
      subs.body.items as { id: string; name: string; type: string; waitingPeriodDays: number }[]
    )
      .filter((s) => s.type === 'PESTICIDE' && s.waitingPeriodDays > 0)
      .sort((a, b) => b.waitingPeriodDays - a.waitingPeriodDays)[0]!;
    // A fresh field: an Approved batch first, then a pesticide treatment today — the batch cannot ship (BR-01).
    const treated: Farm = { ...farm, field: await newField(farm.client, 'Обработанный участок') };
    const approved = await approvedBatch(treated);
    const appliedAt = daysAgo(0.01);
    const t = await farm.client.post(`/fields/${treated.field.id}/treatments`, {
      substanceId: pesticide.id,
      dose: '1.000',
      doseUnit: 'л/га',
      appliedAt,
    });
    expect(t.status, t.text).toBe(201);
    const until = new Date(
      Date.parse(`${appliedAt.slice(0, 10)}T00:00:00Z`) + pesticide.waitingPeriodDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const d2 = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: approved.id, massDeclaredKg: approved.massKg }],
    });
    const br01 = await sendWaybill(farm.client, d2.body);
    expectProblem(br01, 422, 'BUSINESS_RULE', {
      publicCode: approved.publicCode,
      until,
      substance: pesticide.name,
    });
    expect(br01.body.rule).toBe('BR-01');

    // Now the field has a recent pesticide: a new batch goes OnTest (BR-03 RECENT_PESTICIDE) → INVALID_TRANSITION.
    const onTest = await farm.client.post('/batches', {
      fieldId: treated.field.id,
      productId: approved.product.id,
      massKg: '10.000',
      harvestedAt: daysAgo(0.005),
    });
    expect(onTest.status, onTest.text).toBe(201);
    expect(onTest.body).toMatchObject({ status: 'OnTest', testReason: 'RECENT_PESTICIDE' });
    const draft = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: onTest.body.id, massDeclaredKg: '10.000' }],
    });
    expectProblem(await sendWaybill(farm.client, draft.body), 409, 'INVALID_TRANSITION', {
      from: 'OnTest',
      to: 'InTransit',
      publicCode: onTest.body.publicCode,
    });

    // Items are checked in publicCode order, each completely: the older (smaller) code decides first.
    const both = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [
        { batchId: onTest.body.id, massDeclaredKg: '10.000' },
        { batchId: approved.id, massDeclaredKg: approved.massKg },
      ],
    });
    const first = await sendWaybill(farm.client, both.body);
    expectProblem(first, 422, 'BUSINESS_RULE', {
      publicCode: approved.publicCode,
      until,
      substance: pesticide.name,
    });

    // NOT_HOLDER: a batch that left the sender meanwhile (delivered through another waybill).
    const moved = await approvedBatch(farm);
    const dMoved = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: moved.id, massDeclaredKg: moved.massKg }],
    });
    const other = await freshOrg('PROCESSOR');
    await deliver(farm.client, other, moved);
    expectProblem(await sendWaybill(farm.client, dMoved.body), 403, 'FORBIDDEN', {
      reason: 'NOT_HOLDER',
      publicCode: moved.publicCode,
    });
  });

  it('BR-06: a recalled batch cannot ship (422 {publicCode, status}) — a seeded Recalled batch of a processor', async () => {
    const [seed] = await query<{ id: string; public_code: string; mass_kg: string; email: string }>(
      `SELECT b.id, b.public_code, b.mass_kg, u.email FROM batches b
         JOIN organizations o ON o.id = b.holder_org_id AND o.type = 'PROCESSOR'
         JOIN users u ON u.organization_id = o.id AND u.is_org_admin AND u.deleted_at IS NULL
        WHERE b.status = 'Recalled' AND b.deleted_at IS NULL ORDER BY b.public_code LIMIT 1`,
    );
    expect(seed, 'the seed has a Recalled batch held by a processor').toBeDefined();
    const holder = await loginAs('PROCESSOR', { key: seed!.email.split('@')[0] });
    const retailer = await freshOrg('RETAILER');
    const draft = await createWaybill(holder, {
      receiverOrgId: retailer.orgId,
      items: [{ batchId: seed!.id, massDeclaredKg: seed!.mass_kg }],
    });
    expect(draft.status, draft.text).toBe(201);
    const res = await sendWaybill(holder, draft.body);
    expectProblem(res, 422, 'BUSINESS_RULE', { publicCode: seed!.public_code, status: 'Recalled' });
    expect(res.body.rule).toBe('BR-06');
    expect((await deleteWaybill(holder, draft.body.id, 1)).status).toBe(204);
  });
});

describe('acceptWaybill / rejectWaybill', () => {
  it('accept: items must match (400 items.mismatch); BR-07 above 2% without an act; holder and mass change; path stage', async () => {
    const b = await approvedBatch(farm, { massKg: '1000.000' });
    const sent = await sentWaybill(farm.client, processor.orgId, [b]);
    expectProblem(
      await acceptWaybill(farm.client, sent, [{ batchId: b.id, massActualKg: '1000.000' }]),
      403,
      'FORBIDDEN',
      null,
    );
    const retailer = await freshOrg('RETAILER');
    expectProblem(
      await acceptWaybill(retailer.client, sent, [{ batchId: b.id, massActualKg: '1000.000' }]),
      404,
      'NOT_FOUND',
    );
    expectErrors(await acceptWaybill(processor.client, sent, [{ batchId: UUID0, massActualKg: '1.000' }]), {
      items: ['validation.items.mismatch'],
    });
    // A repeated position is a mismatch of step 6 — after the version check (step 4), not a schema error.
    const twice = [
      { batchId: b.id, massActualKg: '1000.000' },
      { batchId: b.id, massActualKg: '1000.000' },
    ];
    expectErrors(await acceptWaybill(processor.client, sent, twice), {
      items: ['validation.items.mismatch'],
    });
    // P36: with another schema error the 400 lists that one only — never the duplicate.
    expectErrors(
      await acceptWaybill(processor.client, sent, [
        { batchId: b.id, massActualKg: '1000' },
        { batchId: b.id, massActualKg: '1000.000' },
      ]),
      { 'items[0].massActualKg': ['validation.mass.format'] },
    );
    // P36: If-Match errors and body errors in one 400.
    const both = await processor.client.post(
      `/waybills/${sent.id}/accept`,
      { items: [{ batchId: b.id, massActualKg: '0.000' }] },
      { headers: { 'Idempotency-Key': idemKey(), 'If-Match': 'W/"2"' } },
    );
    await expectContract(both, 'acceptWaybill');
    expectErrors(both, { 'If-Match': ['validation.type'], 'items[0].massActualKg': ['validation.positive'] });
    expectProblem(
      await acceptWaybill(processor.client, { id: sent.id, version: 1 }, twice),
      409,
      'VERSION_CONFLICT',
      {
        currentVersion: 2,
      },
    );
    expectProblem(
      await acceptWaybill(processor.client, { id: sent.id, version: 1 }, [
        { batchId: b.id, massActualKg: '1000.000' },
      ]),
      409,
      'VERSION_CONFLICT',
      { currentVersion: 2 },
    );
    const br07 = await acceptWaybill(processor.client, sent, [{ batchId: b.id, massActualKg: '970.000' }]);
    expectProblem(br07, 422, 'BUSINESS_RULE', { publicCode: b.publicCode, percent: '3.00' });
    expect(br07.body.rule).toBe('BR-07');
    // Exactly 2% needs no act.
    const ok = await acceptWaybill(processor.client, sent, [{ batchId: b.id, massActualKg: '980.000' }]);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'ACCEPTED',
      version: 3,
      items: [
        {
          massDeclaredKg: '1000.000',
          massActualKg: '980.000',
          discrepancyPercent: '2.00',
          discrepancyAct: null,
        },
      ],
    });
    expect(ok.body.acceptedAt).not.toBeNull();
    const card = await getBatch(processor.client, b.id);
    expect(card.body).toMatchObject({ status: 'Accepted', massKg: '980.000', version: b.version + 2 });
    expect(card.body.holder.id).toBe(processor.orgId);
    expectProblem(
      await acceptWaybill(processor.client, ok.body, [{ batchId: b.id, massActualKg: '980.000' }]),
      409,
      'INVALID_TRANSITION',
      { from: 'ACCEPTED', to: 'ACCEPTED' },
    );
    // An act above 2% is kept.
    const c = await approvedBatch(farm, { massKg: '1000.000' });
    const s2 = await sentWaybill(farm.client, processor.orgId, [c]);
    const act = 'Недостача 50 кг, акт № 5.';
    const withAct = await acceptWaybill(processor.client, s2, [
      { batchId: c.id, massActualKg: '950.000', discrepancyAct: act },
    ]);
    expect(withAct.status, withAct.text).toBe(200);
    expect(withAct.body.items[0]).toMatchObject({ discrepancyPercent: '5.00', discrepancyAct: act });
  });

  it('reject: body required; InTransit batches back to Approved (WAYBILL_REJECTED), holder kept; REJECTED visible to both', async () => {
    const b = await approvedBatch(farm);
    const sent = await sentWaybill(farm.client, processor.orgId, [b]);
    expectErrors(await rejectWaybill(processor.client, sent, ''), { reason: ['validation.required'] });
    const noHeader = await processor.client.post(`/waybills/${sent.id}/reject`, { reason: '' });
    await expectContract(noHeader, 'rejectWaybill');
    expectErrors(noHeader, { 'If-Match': ['validation.required'], reason: ['validation.required'] });
    expectErrors(await rejectWaybill(processor.client, sent, '   '), { reason: ['validation.pattern'] });
    expectProblem(await rejectWaybill(farm.client, sent, 'Не то'), 403, 'FORBIDDEN', null);
    const res = await rejectWaybill(processor.client, sent, 'Влажность выше нормы');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      version: 3,
      rejectReason: 'Влажность выше нормы',
      acceptedAt: null,
    });
    const card = await getBatch(farm.client, b.id);
    expect(card.body).toMatchObject({
      status: 'Approved',
      version: b.version + 2,
      actions: [{ action: 'ship', to: 'InTransit' }],
    });
    const h = await farm.client.get(`/batches/${b.id}/history`);
    expect(h.body.at(-1)).toMatchObject({ from: 'InTransit', to: 'Approved', reason: 'WAYBILL_REJECTED' });
    // The processor still sees the batch (REJECTED waybill with it).
    expect((await getBatch(processor.client, b.id)).status).toBe(200);
    expectProblem(await rejectWaybill(processor.client, res.body, 'Снова'), 409, 'INVALID_TRANSITION', {
      from: 'REJECTED',
      to: 'REJECTED',
    });
  });

  it("reject of a waybill whose batch was recalled in transit: the receiver's open task goes to the sender (R50c), RECALL_TASK REASSIGNED", async () => {
    // Built through the API: a batch in transit to a retailer is recalled by a failed unplanned lab test (the recall
    // engine gives the task to the receiver of the SENT waybill, T9 note c).
    const retailer = await freshOrg('RETAILER');
    const b = await approvedBatch(farm);
    const wb = await sentWaybill(farm.client, retailer.orgId, [b]);
    const inspector = await loginAs('INSPECTOR');
    const lab = await loginAs('LAB', { key: 'vetlab.head' });
    const labOrgId = (await lab.get('/me')).body.organization.id as string;
    const test = await inspector.post('/lab-tests', { batchId: b.id, labOrgId });
    expect(test.status, test.text).toBe(201);
    const failed = await lab.post(
      `/lab-tests/${test.body.id}/results`,
      {
        results: (test.body.norms as { indicatorId: string }[]).map((n) => ({
          indicatorId: n.indicatorId,
          value: '99999',
        })),
      },
      { headers: { 'If-Match': '1' } },
    );
    await expectContract(failed, 'submitLabResults');
    expect(failed.status, failed.text).toBe(200);
    const [seed] = await query<{ task: string; due_at: Date; version: number; holder_org_id: string }>(
      // Task 10's listRecallTasks will show this through the API.
      `SELECT id AS task, due_at, version, holder_org_id FROM recall_tasks WHERE recall_id = $1 AND batch_id = $2`,
      [failed.body.recallId, b.id],
    );
    expect(seed!.holder_org_id).toBe(retailer.orgId);
    const current = (await getWaybill(retailer.client, wb.id)).body;
    // BR-06 blocks the acceptance, the rejection is always possible.
    const acc = await acceptWaybill(retailer.client, current, [{ batchId: b.id, massActualKg: b.massKg }]);
    expectProblem(acc, 422, 'BUSINESS_RULE');
    expect(acc.body.rule).toBe('BR-06');
    const since = await dbNow();
    const res = await rejectWaybill(retailer.client, current, 'Партия отозвана в пути');
    expect(res.status, res.text).toBe(200);
    const [task] = await query<{ holder_org_id: string; due_at: Date; version: number }>(
      `SELECT holder_org_id, due_at, version FROM recall_tasks WHERE id = $1`,
      [seed!.task],
    );
    expect(task).toEqual({ holder_org_id: farm.orgId, due_at: seed!.due_at, version: seed!.version + 1 });
    const ev = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })).filter(
      (e) =>
        e.payload.data.notificationType === 'RECALL_TASK' && e.payload.data.payload.taskId === seed!.task,
    );
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload.data.recipients.orgIds).toEqual([farm.orgId]);
    expect(ev[0]!.payload.data.payload.event).toBe('REASSIGNED');
    expect(instant(ev[0]!.payload.data.payload.dueAt)).toBe(instant(seed!.due_at));
    // The recalled batch keeps its status (only InTransit batches go back to Approved).
    for (const i of res.body.items as { batch: { status: string } }[])
      expect(i.batch.status).toBe('Recalled');
  });
});

describe('deleteWaybill and visibility', () => {
  it('only the sender deletes, only a DRAFT, with If-Match; a deleted waybill is gone for everybody', async () => {
    const b = await approvedBatch(farm);
    const draft = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: b.id, massDeclaredKg: b.massKg }],
    });
    expectErrors(await deleteWaybill(farm.client, draft.body.id, undefined), {
      'If-Match': ['validation.required'],
    });
    expectProblem(await deleteWaybill(processor.client, draft.body.id, 1), 404, 'NOT_FOUND');
    expectProblem(await deleteWaybill(farm.client, draft.body.id, 5), 409, 'VERSION_CONFLICT', {
      currentVersion: 1,
    });
    expectProblem(await deleteWaybill(await loginAs('RETAILER'), draft.body.id, 1), 403, 'FORBIDDEN', null);
    const res = await deleteWaybill(farm.client, draft.body.id, 1);
    expect(res.status, res.text).toBe(204);
    expectProblem(await getWaybill(farm.client, draft.body.id), 404, 'NOT_FOUND');
    expectProblem(await deleteWaybill(farm.client, draft.body.id, 1), 404, 'NOT_FOUND');
    // A SENT waybill seen by the receiver: deleting is the sender's — NOT_SENDER.
    const sent = await sentWaybill(farm.client, processor.orgId, [await approvedBatch(farm)]);
    expectProblem(await deleteWaybill(processor.client, sent.id, sent.version), 403, 'FORBIDDEN', {
      reason: 'NOT_SENDER',
    });
    expect((await auditEntries({ action: 'deleteWaybill', entityId: draft.body.id })).length).toBe(1);
  });

  it('listWaybills: direction only for participants (R51); status, counterpartyOrgId, q; LAB has no access', async () => {
    const inspector = await loginAs('INSPECTOR');
    expectErrors(await listWaybills(inspector, { direction: 'incoming' }), {
      direction: ['validation.direction.notAllowed'],
    });
    expectProblem(await listWaybills(await loginAs('LAB')), 403, 'FORBIDDEN', null);
    expectProblem(await listWaybills(api()), 401, 'UNAUTHORIZED');
    expectErrors(await listWaybills(farm.client, { sort: 'status,asc' }), { sort: ['validation.sort'] });
    const b = await approvedBatch(farm);
    const sent = await sentWaybill(farm.client, processor.orgId, [b]);
    const out = await listWaybills(farm.client, { direction: 'outgoing', q: b.publicCode.toLowerCase() });
    expect(out.body.items.map((w: { id: string }) => w.id)).toEqual([sent.id]);
    expect((await listWaybills(farm.client, { direction: 'incoming', q: sent.number })).body.total).toBe(0);
    const inc = await listWaybills(processor.client, {
      direction: 'incoming',
      status: 'SENT',
      counterpartyOrgId: farm.orgId,
    });
    expect(inc.body.items.map((w: { id: string }) => w.id)).toContain(sent.id);
    for (const w of inc.body.items) expect(w.sender.id).toBe(farm.orgId);
    const all = await listWaybills(inspector, { counterpartyOrgId: processor.orgId, size: 100 });
    expect(all.body.items.map((w: { id: string }) => w.id)).toContain(sent.id);
    for (const w of all.body.items) expect(w.status).not.toBe('DRAFT');
    const sorted = await listWaybills(inspector, { sort: 'number,asc', size: 100 });
    const nums = sorted.body.items.map((w: { number: string }) => w.number);
    expect(nums).toEqual([...nums].sort());
  });
});

describe('Idempotency-Key (R48, R53)', () => {
  it('a repeat with the same key and request: the stored response, Idempotent-Replayed: true; the record in Redis', async () => {
    const b = await approvedBatch(farm);
    const key = idemKey();
    const body = { receiverOrgId: processor.orgId, items: [{ batchId: b.id, massDeclaredKg: b.massKg }] };
    const first = await createWaybill(farm.client, body, key);
    expect(first.status, first.text).toBe(201);
    expect(first.headers.get('idempotent-replayed')).not.toBe('true');
    const again = await createWaybill(farm.client, body, key);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(instants(again.body)).toEqual(instants(first.body));
    expect((await listWaybills(farm.client, { q: b.publicCode })).body.total).toBe(1);
    const uid = await userId(farm.client);
    const raw = await redis().get(`idem:${uid}:${key}`);
    const rec = JSON.parse(raw!);
    expect(rec).toEqual({
      fingerprint: sha256hex(`POST /api/v1/waybills\n${JSON.stringify(body)}`),
      state: 'done',
      status: 201,
      body: first.body,
    });
    const ttl = await redis().ttl(`idem:${uid}:${key}`);
    expect(ttl).toBeGreaterThan(86000);
    expect(ttl).toBeLessThanOrEqual(86400);
    // Keys are per user: another user with the same key executes on its own.
    const other = await createWaybill(
      processor.client,
      { receiverOrgId: farm.orgId, items: body.items },
      key,
    );
    expect(other.headers.get('idempotent-replayed')).not.toBe('true');
  });

  it('the same key with another request → 409 IDEMPOTENCY_KEY_REUSED; a pending record → 409 IN_PROGRESS + Retry-After: 1', async () => {
    const b = await approvedBatch(farm);
    const key = idemKey();
    const body = { receiverOrgId: processor.orgId, items: [{ batchId: b.id, massDeclaredKg: b.massKg }] };
    expect((await createWaybill(farm.client, body, key)).status).toBe(201);
    const changed = { ...body, items: [{ batchId: b.id, massDeclaredKg: '1.000' }] };
    expectProblem(await createWaybill(farm.client, changed, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    const sameBodyOtherPath = await farm.client.post(`/batches/${b.id}/documents/vsd/retry`, body, {
      headers: { 'Idempotency-Key': key },
    });
    await expectContract(sameBodyOtherPath, 'retryBatchVsdImport');
    expectProblem(sameBodyOtherPath, 409, 'IDEMPOTENCY_KEY_REUSED');

    const uid = await userId(farm.client);
    const k2 = idemKey();
    const raw = JSON.stringify(body);
    await redis().set(
      `idem:${uid}:${k2}`,
      JSON.stringify({ fingerprint: sha256hex(`POST /api/v1/waybills\n${raw}`), state: 'pending' }),
      'EX',
      60,
    );
    const busy = await farm.client.post('/waybills', raw, {
      headers: { 'Idempotency-Key': k2, 'content-type': 'application/json' },
    });
    await expectContract(busy, 'createWaybill');
    expectProblem(busy, 409, 'IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(busy.headers.get('retry-after')).toBe('1');
    // A different request with that pending key is REUSED, not IN_PROGRESS.
    expectProblem(await createWaybill(farm.client, changed, k2), 409, 'IDEMPOTENCY_KEY_REUSED');
    // The pending record is foreign: nothing in this request touched it.
    expect(JSON.parse((await redis().get(`idem:${uid}:${k2}`))!).state).toBe('pending');
    await redis().del(`idem:${uid}:${k2}`);
  });

  it('a done record written by any backend is replayed (shared Redis format)', async () => {
    const uid = await userId(farm.client);
    const key = idemKey();
    const raw = JSON.stringify({
      receiverOrgId: processor.orgId,
      items: [{ batchId: UUID0, massDeclaredKg: '1.000' }],
    });
    const stored = { id: UUID0, note: 'stored elsewhere' };
    await redis().set(
      `idem:${uid}:${key}`,
      JSON.stringify({
        fingerprint: sha256hex(`POST /api/v1/waybills\n${raw}`),
        state: 'done',
        status: 201,
        body: stored,
      }),
      'EX',
      120,
    );
    const res = await farm.client.post('/waybills', raw, {
      headers: { 'Idempotency-Key': key, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect(res.contentType).toBe('application/json');
    expect(res.headers.get('idempotent-replayed')).toBe('true');
    expect(res.body).toEqual(stored);
    await redis().del(`idem:${uid}:${key}`);
  });

  it('after a 4xx the key is free: the same request with the same key executes again', async () => {
    const b = await approvedBatch(farm);
    const draft = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: b.id, massDeclaredKg: b.massKg }],
    });
    const key = idemKey();
    // Same method, path and (empty) body; only If-Match differs — it is not part of the fingerprint.
    expectProblem(
      await sendWaybill(farm.client, { id: draft.body.id, version: 9 }, key),
      409,
      'VERSION_CONFLICT',
      {
        currentVersion: 1,
      },
    );
    const uid = await userId(farm.client);
    expect(await redis().exists(`idem:${uid}:${key}`)).toBe(0);
    const ok = await sendWaybill(farm.client, draft.body, key);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.headers.get('idempotent-replayed')).not.toBe('true');
    const replay = await sendWaybill(farm.client, draft.body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.version).toBe(2);
  });
});

describe('races (Review Focus 1)', () => {
  it('two parallel sends of drafts sharing one batch: exactly one 200, the other 409 INVALID_TRANSITION of the batch', async () => {
    for (let round = 0; round < 3; round++) {
      const b = await approvedBatch(farm);
      const mk = () =>
        createWaybill(farm.client, {
          receiverOrgId: processor.orgId,
          items: [{ batchId: b.id, massDeclaredKg: b.massKg }],
        });
      const [d1, d2] = [await mk(), await mk()];
      const results = await Promise.all([
        sendWaybill(farm.client, d1.body),
        sendWaybill(farm.client, d2.body),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, results.map((r) => r.text).join('\n')).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expectProblem(loser, 409, 'INVALID_TRANSITION', {
        from: 'InTransit',
        to: 'InTransit',
        publicCode: b.publicCode,
      });
      const card = await getBatch(farm.client, b.id);
      expect(card.body).toMatchObject({ status: 'InTransit', version: b.version + 1 });
    }
  });

  it('parallel accept and reject of one waybill: exactly one wins', async () => {
    const b = await approvedBatch(farm);
    const sent = await sentWaybill(farm.client, processor.orgId, [b]);
    const [a, r] = await Promise.all([
      acceptWaybill(processor.client, sent, [{ batchId: b.id, massActualKg: b.massKg }]),
      rejectWaybill(processor.client, sent, 'Параллельный отказ'),
    ]);
    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : r;
    expect(['VERSION_CONFLICT', 'INVALID_TRANSITION']).toContain(loser.body.code);
  });
});
