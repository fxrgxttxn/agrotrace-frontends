/**
 * Processing (contracts/openapi/paths/processing.yaml; FR-PROD-06, БП-4, BR-04/05/06, D19, D20, R47): the check order
 * (schema → references in one 400 → per input NOT_HOLDER / BR-06 / BR-05 → BR-04 balance), the result (inputs
 * Processed with their mass kept, DERIVED outputs Approved at version 2 with the history null → Created → Approved,
 * one batch_links edge per (input, output) with the input's massUsedKg), MassTotal strings in `balance` and BR-04
 * params (per-input truncation of fractional grams), the public page cache, and the races with sendWaybill and with a
 * second processing (Review Focus 1: exactly one wins).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_EMAILS, loginAs } from './lib/auth.js';
import { auditEntries } from './lib/audit.js';
import type { ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import {
  acceptedAt,
  approvedBatch,
  createWaybill,
  flour,
  freshOrg,
  getBatch,
  grams,
  kg,
  petrov,
  processBatches,
  productOf,
  sendWaybill,
  sentWaybill,
  wheat,
  type Farm,
} from './lib/production.js';
import { closeRedis, redis } from './lib/redis.js';
import { instant } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const UUID0 = '00000000-0000-4000-8000-000000000000';

async function history(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}/history`);
  await expectContract(res, 'getBatchHistory');
  expect(res.status, res.text).toBe(200);
  return res.body as { from: string | null; to: string; reason: string; changedBy: unknown }[];
}

/** BR-04 allowance of one input: massUsedKg × (1 − loss/100), fractional grams dropped per input. */
const allowance = (massUsedKg: string, lossPercent: string): bigint => {
  const [i, f = ''] = lossPercent.split('.');
  const bp = BigInt(i!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2));
  return (grams(massUsedKg) * (10000n - bp)) / 10000n;
};

let farm: Farm;
let processor: { client: ApiClient; orgId: string; userId: string };
let wheatLoss: string;
let flourId: string;
beforeAll(async () => {
  farm = await petrov();
  processor = await freshOrg('PROCESSOR');
  const w = await wheat();
  wheatLoss = w.lossNormPercent;
  flourId = (await flour()).id;
});

describe('processBatches: request checks', () => {
  it('x-roles PROCESSOR only; body by schema: required, minItems, mass format, repeated batchId', async () => {
    const body = {
      inputs: [{ batchId: UUID0, massUsedKg: '1.000' }],
      outputs: [{ productId: UUID0, massKg: '1.000' }],
    };
    for (const role of ['FARMER', 'RETAILER', 'LAB', 'INSPECTOR', 'ADMIN'] as const) {
      const res = await (await loginAs(role)).post('/processing', body);
      await expectContract(res, 'processBatches');
      expectProblem(res, 403, 'FORBIDDEN', null);
    }
    const p = processor.client;
    expectErrors(await processBatches(p, undefined as never, undefined as never), {
      inputs: ['validation.required'],
      outputs: ['validation.required'],
    });
    expectErrors(await processBatches(p, [], []), {
      inputs: ['validation.minItems'],
      outputs: ['validation.minItems'],
    });
    expectErrors(
      await processBatches(p, [{ batchId: UUID0, massUsedKg: '5' }], [{ productId: UUID0, massKg: '0.000' }]),
      { 'inputs[0].massUsedKg': ['validation.mass.format'], 'outputs[0].massKg': ['validation.positive'] },
    );
    // A repeated input is a schema error (step 1), reported before any reference.
    expectErrors(
      await processBatches(
        p,
        [
          { batchId: UUID0, massUsedKg: '1.000' },
          { batchId: UUID0, massUsedKg: '2.000' },
        ],
        [{ productId: UUID0, massKg: '1.000' }],
      ),
      { 'inputs[1].batchId': ['validation.duplicate'] },
    );
  });

  it('references in one 400: unknown or invisible input, massUsedKg above the batch mass, unknown or deleted product', async () => {
    const own = await acceptedAt(farm, processor);
    const foreign = await approvedBatch(farm); // the processor does not see a farm batch it never received
    const admin = await loginAs('ADMIN', { head: true });
    const created = await admin.post('/dictionaries/products', {
      name: `Удалённый продукт ${Date.now()}`,
      category: 'PROCESSED',
      lossNormPercent: '1.00',
    });
    expect(created.status, created.text).toBe(201);
    const del = await admin.delete(`/dictionaries/products/${created.body.id}`);
    expect(del.status, del.text).toBe(204);
    const res = await processBatches(
      processor.client,
      [
        { batchId: UUID0, massUsedKg: '1.000' },
        { batchId: foreign.id, massUsedKg: '1.000' },
        { batchId: own.id, massUsedKg: kg(grams(own.massKg) + 1n) },
      ],
      [
        { productId: flourId, massKg: '1.000' },
        { productId: UUID0, massKg: '1.000' },
        { productId: created.body.id, massKg: '1.000' },
      ],
    );
    expectErrors(res, {
      'inputs[0].batchId': ['validation.notFound'],
      'inputs[1].batchId': ['validation.notFound'],
      'inputs[2].massUsedKg': ['validation.mass.exceedsBatch'],
      'outputs[1].productId': ['validation.notFound'],
      'outputs[2].productId': ['validation.notFound'],
    });
    expect((await getBatch(processor.client, own.id)).body).toMatchObject({
      status: 'Accepted',
      version: own.version,
    });
  });

  it('per input in request order: NOT_HOLDER {publicCode}, BR-05 {publicCode, status} (InTransit, Processed)', async () => {
    const held = await acceptedAt(farm, processor);
    // Visible to the processor (receiver of a SENT waybill) but still held by the farm.
    const incoming = await approvedBatch(farm);
    await sentWaybill(farm.client, processor.orgId, [incoming]);
    const out = [{ productId: flourId, massKg: '0.500' }];
    expectProblem(
      await processBatches(
        processor.client,
        [
          { batchId: held.id, massUsedKg: '1.000' },
          { batchId: incoming.id, massUsedKg: '1.000' },
        ],
        out,
      ),
      403,
      'FORBIDDEN',
      { reason: 'NOT_HOLDER', publicCode: incoming.publicCode },
    );

    // InTransit (held by the processor, shipped onward) is not an input (canUseAsInput).
    const retailer = await freshOrg('RETAILER');
    const shipped = await acceptedAt(farm, processor);
    await sentWaybill(processor.client, retailer.orgId, [shipped]);
    const br05 = await processBatches(
      processor.client,
      [
        { batchId: held.id, massUsedKg: '1.000' },
        { batchId: shipped.id, massUsedKg: '1.000' },
      ],
      out,
    );
    expectProblem(br05, 422, 'BUSINESS_RULE', { publicCode: shipped.publicCode, status: 'InTransit' });
    expect(br05.body.rule).toBe('BR-05');

    const ok = await processBatches(processor.client, [{ batchId: held.id, massUsedKg: '1.000' }], out);
    expect(ok.status, ok.text).toBe(201);
    const again = await processBatches(processor.client, [{ batchId: held.id, massUsedKg: '1.000' }], out);
    expectProblem(again, 422, 'BUSINESS_RULE', { publicCode: held.publicCode, status: 'Processed' });
    expect(again.body.rule).toBe('BR-05');
  });

  it('BR-06 {publicCode, status} for a Recalled input — a seeded Recalled batch held by a processor', async () => {
    const [seed] = await query<{ id: string; public_code: string; email: string }>(
      `SELECT b.id, b.public_code, u.email FROM batches b
         JOIN organizations o ON o.id = b.holder_org_id AND o.type = 'PROCESSOR'
         JOIN users u ON u.organization_id = o.id AND u.is_org_admin AND u.deleted_at IS NULL
          AND u.email = ANY($1::text[])
        WHERE b.status = 'Recalled' AND b.deleted_at IS NULL ORDER BY b.public_code LIMIT 1`,
      [DEMO_EMAILS],
    );
    expect(seed, 'the seed has a Recalled batch held by a processor').toBeDefined();
    const holder = await loginAs('PROCESSOR', { key: seed!.email.split('@')[0] });
    const res = await processBatches(
      holder,
      [{ batchId: seed!.id, massUsedKg: '0.001' }],
      [{ productId: flourId, massKg: '0.001' }],
    );
    expectProblem(res, 422, 'BUSINESS_RULE', { publicCode: seed!.public_code, status: 'Recalled' });
    expect(res.body.rule).toBe('BR-06');
  });

  it('BR-04 {inputKg, allowedKg, outputKg} as MassTotal strings; fractional grams dropped per input', async () => {
    const a = await acceptedAt(farm, processor);
    const b = await acceptedAt(farm, processor);
    // 1 g each: 1 × (1 − 1.5%) = 0.985 g → 0 g per input (summed first it would be 1 g).
    const tiny = await processBatches(
      processor.client,
      [
        { batchId: a.id, massUsedKg: '0.001' },
        { batchId: b.id, massUsedKg: '0.001' },
      ],
      [{ productId: flourId, massKg: '0.001' }],
    );
    expectProblem(tiny, 422, 'BUSINESS_RULE', { inputKg: '0.002', allowedKg: '0.000', outputKg: '0.001' });
    expect(tiny.body.rule).toBe('BR-04');

    const allowed = allowance('1000.000', wheatLoss) + allowance('333.333', wheatLoss);
    const over = await processBatches(
      processor.client,
      [
        { batchId: a.id, massUsedKg: '1000.000' },
        { batchId: b.id, massUsedKg: '333.333' },
      ],
      [
        { productId: flourId, massKg: '500.000' },
        { productId: flourId, massKg: kg(allowed - 500_000n + 1n) },
      ],
    );
    expectProblem(over, 422, 'BUSINESS_RULE', {
      inputKg: '1333.333',
      allowedKg: kg(allowed),
      outputKg: kg(allowed + 1n),
    });
    expect(over.body.rule).toBe('BR-04');
    // Nothing changed.
    for (const x of [a, b])
      expect((await getBatch(processor.client, x.id)).body).toMatchObject({
        status: 'Accepted',
        version: x.version,
      });
  });

  it('BR-04 takes the loss norm of each input product (wheat and potato differ)', async () => {
    const potato = await productOf(
      (p) => p.category === 'VEGETABLE' && p.name === 'Картофель продовольственный',
    );
    expect(potato.lossNormPercent).not.toBe(wheatLoss);
    const w = await acceptedAt(farm, processor);
    const v = await acceptedAt(farm, processor, { productId: potato.id });
    const allowed = allowance('1000.000', wheatLoss) + allowance('1000.000', potato.lossNormPercent);
    const inputs = [
      { batchId: w.id, massUsedKg: '1000.000' },
      { batchId: v.id, massUsedKg: '1000.000' },
    ];
    const over = await processBatches(processor.client, inputs, [
      { productId: flourId, massKg: kg(allowed + 1n) },
    ]);
    expectProblem(over, 422, 'BUSINESS_RULE', {
      inputKg: '2000.000',
      allowedKg: kg(allowed),
      outputKg: kg(allowed + 1n),
    });
    const ok = await processBatches(processor.client, inputs, [{ productId: flourId, massKg: kg(allowed) }]);
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.balance).toEqual({ inputKg: '2000.000', allowedKg: kg(allowed), outputKg: kg(allowed) });
  });
});

describe('processBatches: result', () => {
  it('inputs → Processed (mass kept), DERIVED outputs Approved v2 in request order, links per pair, balance, history, audit', async () => {
    const a = await acceptedAt(farm, processor, { massKg: '1000.000' });
    const b = await acceptedAt(farm, processor, { massKg: '500.000' });
    await redis().set(`pub:batch:${a.publicCode}`, '{"stale":true}', 'EX', 300);
    const allowed = allowance('1000.000', wheatLoss) + allowance('200.000', wheatLoss);
    const res = await processBatches(
      processor.client,
      [
        { batchId: a.id, massUsedKg: '1000.000' },
        { batchId: b.id, massUsedKg: '200.000' },
      ],
      [
        { productId: flourId, massKg: '700.000' },
        { productId: flourId, massKg: kg(allowed - 700_000n) },
      ],
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body.balance).toEqual({ inputKg: '1200.000', allowedKg: kg(allowed), outputKg: kg(allowed) });
    const outputs = res.body.outputs as {
      id: string;
      publicCode: string;
      massKg: string;
      status: string;
      kind: string;
      holder: { id: string };
      origin: { id: string };
      harvestedAt: string | null;
      producedAt: string;
      field: unknown;
      testRequired: boolean;
      testReason: string;
      version: number;
      actions: unknown[];
      product: { id: string };
    }[];
    expect(outputs.map((o) => o.massKg)).toEqual(['700.000', kg(allowed - 700_000n)]);
    for (const o of outputs) {
      expect(o).toMatchObject({
        status: 'Approved',
        kind: 'DERIVED',
        holder: { id: processor.orgId },
        origin: { id: processor.orgId },
        harvestedAt: null,
        field: null,
        testRequired: false,
        testReason: 'NONE',
        version: 2,
        product: { id: flourId },
      });
      expect(o.publicCode).toMatch(/^AT-\d{4}-\d{6,}$/);
      expect(instant(o.producedAt)).toBe(instant(outputs[0]!.producedAt));
      expect(o.actions).toEqual([
        { action: 'ship', to: 'InTransit' },
        { action: 'process', to: 'Processed' },
      ]);
      const h = await history(processor.client, o.id);
      expect(h.map((x) => [x.from, x.to, x.reason, x.changedBy === null])).toEqual([
        [null, 'Created', 'CREATED', false],
        ['Created', 'Approved', 'TEST_NOT_REQUIRED', true],
      ]);
    }
    for (const [x, mass] of [
      [a, '1000.000'],
      [b, '500.000'],
    ] as const) {
      const card = (await getBatch(processor.client, x.id)).body;
      expect(card).toMatchObject({ status: 'Processed', version: x.version + 1, massKg: mass });
      expect(card.actions).toEqual([]);
      const h = await history(processor.client, x.id);
      expect(h.at(-1)).toMatchObject({ from: 'Accepted', to: 'Processed', reason: 'PROCESSED' });
      expect(h.at(-1)!.changedBy).not.toBeNull();
    }
    expect(await redis().exists(`pub:batch:${a.publicCode}`)).toBe(0);

    // D20: one edge per (input, output) with the input's whole massUsedKg.
    const g = await processor.client.get(`/batches/${outputs[1]!.id}/graph`, { query: { depth: 1 } });
    await expectContract(g, 'getBatchGraph');
    expect(g.status, g.text).toBe(200);
    expect(
      (g.body.edges as { parent: string; child: string; massUsedKg: string }[])
        .map((e) => [e.parent, e.child, e.massUsedKg])
        .sort(),
    ).toEqual(
      [
        [a.id, outputs[1]!.id, '1000.000'],
        [b.id, outputs[1]!.id, '200.000'],
      ].sort(),
    );
    const links = await query<{ parent_batch_id: string; child_batch_id: string; mass_used_kg: string }>(
      `SELECT parent_batch_id, child_batch_id, mass_used_kg FROM batch_links WHERE parent_batch_id = ANY($1)`,
      [[a.id, b.id]],
    );
    expect(links.length).toBe(4);

    // The farm sees its batches' children (N), the processor's own outputs.
    expect((await getBatch(farm.client, outputs[0]!.id)).status).toBe(200);

    const audit = await auditEntries({ action: 'processBatches', entityId: outputs[0]!.id });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!.diff).toMatchObject({
      status: [null, 'Approved'],
      kind: [null, 'DERIVED'],
      version: [null, 2],
    });
    const inAudit = await auditEntries({ action: 'processBatches', entityId: a.id });
    expect(inAudit.map((e) => e.diff)).toContainEqual({
      status: ['Accepted', 'Processed'],
      version: [a.version, a.version + 1],
    });
  });

  it('an Approved own batch is an input too (canUseAsInput: Approved or Accepted)', async () => {
    const parent = await acceptedAt(farm, processor);
    const first = await processBatches(
      processor.client,
      [{ batchId: parent.id, massUsedKg: '100.000' }],
      [{ productId: flourId, massKg: '50.000' }],
    );
    expect(first.status, first.text).toBe(201);
    const derived = first.body.outputs[0];
    const second = await processBatches(
      processor.client,
      [{ batchId: derived.id, massUsedKg: '50.000' }],
      [{ productId: flourId, massKg: '40.000' }],
    );
    expect(second.status, second.text).toBe(201);
    expect((await getBatch(processor.client, derived.id)).body).toMatchObject({
      status: 'Processed',
      version: 3,
    });
  });
});

describe('races (Review Focus 1)', () => {
  it('processBatches vs sendWaybill over one batch: exactly one succeeds, the other is refused (409 / 422 BR-05)', async () => {
    const retailer = await freshOrg('RETAILER');
    for (let round = 0; round < 3; round++) {
      const b = await acceptedAt(farm, processor);
      const draft = await createWaybill(processor.client, {
        receiverOrgId: retailer.orgId,
        items: [{ batchId: b.id, massDeclaredKg: b.massKg }],
      });
      expect(draft.status, draft.text).toBe(201);
      const [proc, send] = await Promise.all([
        processBatches(
          processor.client,
          [{ batchId: b.id, massUsedKg: b.massKg }],
          [{ productId: flourId, massKg: '1.000' }],
        ),
        sendWaybill(processor.client, draft.body),
      ]);
      const ok = [proc.status === 201, send.status === 200];
      expect(ok.filter(Boolean).length, `${proc.text}\n${send.text}`).toBe(1);
      const card = (await getBatch(processor.client, b.id)).body;
      if (ok[0]) {
        // The send saw the batch Processed under its lock.
        expectProblem(send, 409, 'INVALID_TRANSITION', {
          from: 'Processed',
          to: 'InTransit',
          publicCode: b.publicCode,
        });
        expect(card).toMatchObject({ status: 'Processed', version: b.version + 1 });
      } else {
        // The processing saw it InTransit under its lock: not an input (BR-05).
        expectProblem(proc, 422, 'BUSINESS_RULE', { publicCode: b.publicCode, status: 'InTransit' });
        expect(card).toMatchObject({ status: 'InTransit', version: b.version + 1 });
      }
    }
  });

  it('two parallel processings of one input: exactly one 201, the other 422 BR-05 Processed', async () => {
    const b = await acceptedAt(farm, processor);
    const run = () =>
      processBatches(
        processor.client,
        [{ batchId: b.id, massUsedKg: '10.000' }],
        [{ productId: flourId, massKg: '1.000' }],
      );
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.status).sort(), results.map((r) => r.text).join('\n')).toEqual([201, 422]);
    const loser = results.find((r) => r.status === 422)!;
    expectProblem(loser, 422, 'BUSINESS_RULE', { publicCode: b.publicCode, status: 'Processed' });
    const children = await query(`SELECT 1 FROM batch_links WHERE parent_batch_id = $1`, [b.id]);
    expect(children.length).toBe(1);
  });
});
