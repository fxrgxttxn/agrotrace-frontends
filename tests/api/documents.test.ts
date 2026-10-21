/**
 * Batch documents and the ФГИС «Меркурий» VSD import (R81, R91; getBatchDocuments, retryBatchVsdImport,
 * contracts/events/vsd.import.schema.json): a DAIRY/MEAT batch gets a PENDING VSD and a `vsd.import` outbox event in
 * its transaction; the worker imports it from mercury-mock (IMPORTED with the latest CONFIRMED document of the farm and
 * product within harvestedAt ± 3 days, NOT_FOUND, FAILED after 6 calls); the retry is allowed only from NOT_FOUND or
 * FAILED; the batch is never held back by the import.
 *
 * The FAILED path uses the test stand's adapter setting (docker-compose.api-test.yml, worker): Mercury calls for the
 * product code FAIL_CODE carry `X-Mock-Fail: 500` and the retry delays are shortened — the product is created here
 * through the dictionary API when the dev DB does not have it yet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs } from './lib/auth.js';
import type { ApiClient } from './lib/client.js';
import { expectContract, schemaErrors } from './lib/contract.js';
import { API_BACKEND } from './lib/env.js';
import { closeDb, dbNow, outboxEvents } from './lib/db.js';
import { expectProblem } from './lib/expect.js';
import { platformAdmin } from './lib/fixtures.js';
import {
  approvedBatch,
  beef,
  createBatch,
  createWaybill,
  daysAgo,
  deliver,
  eventually,
  freshOrg,
  getBatch,
  idemKey,
  petrov,
  products,
  sendWaybill,
  wheat,
  type Farm,
} from './lib/production.js';
import { closeRedis } from './lib/redis.js';
import { instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

/** docker-compose.api-test.yml: MERCURY_FAIL_PRODUCT_CODES of the worker. */
const FAIL_CODE = '99.99.99';
const BACKEND = API_BACKEND;

async function documents(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}/documents`);
  await expectContract(res, 'getBatchDocuments');
  return res;
}
async function retry(client: ApiClient, id: string, key = idemKey()) {
  const res = await client.post(`/batches/${id}/documents/vsd/retry`, undefined, {
    headers: { 'Idempotency-Key': key },
  });
  await expectContract(res, 'retryBatchVsdImport');
  return res;
}

/** The VSD once the worker finished it (importStatus other than PENDING). */
async function settled(client: ApiClient, id: string, timeoutMs = 30000) {
  return eventually(async () => {
    const res = await documents(client, id);
    expect(res.status, res.text).toBe(200);
    return res.body.vsd && res.body.vsd.importStatus !== 'PENDING' ? res.body.vsd : undefined;
  }, timeoutMs);
}

let failingProductId: Promise<string> | null = null;
/** The test-only product with the failing Mercury code (created once per run when the dev DB lacks it). */
function failingProduct(): Promise<string> {
  failingProductId ??= createFailingProduct();
  return failingProductId;
}

async function createFailingProduct(): Promise<string> {
  const existing = (await products()).find((p) => p.mercuryCode === FAIL_CODE);
  if (existing) return existing.id;
  const res = await (
    await platformAdmin()
  ).post('/dictionaries/products', {
    name: 'Говядина тестовая (сбой Меркурия)',
    category: 'MEAT',
    lossNormPercent: '1.00',
    mercuryCode: FAIL_CODE,
  });
  await expectContract(res, 'createDictionaryEntry');
  expect(res.status, res.text).toBe(201);
  return res.body.id;
}

let farm: Farm;
beforeAll(async () => {
  farm = await petrov();
});

describe('getBatchDocuments', () => {
  it('a batch without VSD (not DAIRY/MEAT): vsd null, no protocols, qr null; invisible → 404', async () => {
    const b = await approvedBatch(farm, { productId: (await wheat()).id });
    const res = await documents(farm.client, b.id);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ batchId: b.id, vsd: null, labProtocols: [], qr: null });
    const stranger = await freshOrg('PROCESSOR');
    expectProblem(await documents(stranger.client, b.id), 404, 'NOT_FOUND');
  });

  it('seeded protocols: every visible lab test with a protocol, ordered by createdAt; LAB sees only its own', async () => {
    const inspector = await loginAs('INSPECTOR');
    // A seeded batch with protocols of both labs, if any; otherwise any batch with a protocol.
    // Every page: other suites add batches of their own (newest first), so seeded ones may be past page 1.
    const items: { id: string }[] = [];
    for (let page = 1; ; page++) {
      const list = await inspector.get('/batches', { query: { size: 100, page } });
      items.push(...(list.body.items as { id: string }[]));
      if (items.length >= list.body.total || list.body.items.length === 0) break;
    }
    let checked = 0;
    for (const item of items.reverse()) {
      const res = await documents(inspector, item.id);
      if (res.body.labProtocols.length === 0) continue;
      checked++;
      for (const key of ['vetlab.head', 'agrotest.head']) {
        const lab = await loginAs('LAB', { key });
        const me = (await lab.get('/me')).body.organization.id;
        const own = res.body.labProtocols.filter((x: { lab: { id: string } }) => x.lab.id === me);
        const seen = await documents(lab, item.id);
        if (own.length === 0) {
          expect([200, 404]).toContain(seen.status);
          if (seen.status === 200) expect(seen.body.labProtocols).toEqual([]);
        } else {
          expect(seen.status).toBe(200);
          expect(seen.body.labProtocols.map((x: { labTestId: string }) => x.labTestId)).toEqual(
            own.map((x: { labTestId: string }) => x.labTestId),
          );
          expect(seen.body.qr).toBeNull();
        }
      }
      if (checked >= 3) break;
    }
    expect(checked, 'the seed has batches with lab protocols').toBeGreaterThan(0);
  });
});

describe('VSD import (R81)', () => {
  it('createBatch of a MEAT product: a PENDING VSD and `vsd.import` in the same transaction, published; IMPORTED from Mercury', async () => {
    const since = await dbNow();
    // VSD-2026-000012 (КФХ Петров, beef 10.11.11) is dated 49 days before mercury-mock's "now" (R90 relative dates).
    const res = await createBatch(farm.client, {
      fieldId: farm.field.id,
      productId: (await beef()).id,
      massKg: '2400.000',
      harvestedAt: daysAgo(49),
    });
    expect(res.status, res.text).toBe(201);
    expect(['Approved', 'OnTest']).toContain(res.body.status);
    const [event] = (await outboxEvents({ backend: BACKEND, type: 'vsd.import', since })).filter(
      (e) => e.payload.data.batchId === res.body.id,
    );
    expect(event, 'vsd.import outbox row').toBeDefined();
    expect(event!.payload).toMatchObject({
      type: 'vsd.import',
      backend: BACKEND,
      data: { batchId: res.body.id, publicCode: res.body.publicCode },
    });
    const vsd = await settled(farm.client, res.body.id);
    expect(vsd).toMatchObject({
      id: event!.payload.data.documentId,
      importStatus: 'IMPORTED',
      attempts: 1,
      document: {
        number: 'VSD-2026-000012',
        status: 'CONFIRMED',
        consignor: { inn: '502701234075' },
      },
    });
    expect(await schemaErrors('BatchVsd', vsd)).toEqual([]);
    const card = await getBatch(farm.client, res.body.id);
    expect(card.body.status).toBe(res.body.status);
    expect(card.body.version).toBe(res.body.version);
    // Retry from IMPORTED: 409 INVALID_TRANSITION.
    expectProblem(await retry(farm.client, res.body.id), 409, 'INVALID_TRANSITION', {
      from: 'IMPORTED',
      to: 'PENDING',
    });
  });

  it('no CONFIRMED document in the window → NOT_FOUND; the retry resets it to PENDING (202) and imports again', async () => {
    const res = await createBatch(farm.client, {
      fieldId: farm.field.id,
      productId: (await beef()).id,
      massKg: '100.000',
      harvestedAt: daysAgo(2),
    });
    expect(res.status, res.text).toBe(201);
    const vsd = await settled(farm.client, res.body.id);
    expect(vsd).toMatchObject({ importStatus: 'NOT_FOUND', document: null, attempts: 1 });
    const since = await dbNow();
    const key = idemKey();
    const r = await retry(farm.client, res.body.id, key);
    expect(r.status, r.text).toBe(202);
    expect(r.body).toMatchObject({ id: vsd.id, importStatus: 'PENDING', document: null, attempts: 0 });
    // The same key again: the stored answer (R48).
    const replay = await retry(farm.client, res.body.id, key);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(instants(replay.body)).toEqual(instants(r.body));
    const events = (await outboxEvents({ backend: BACKEND, type: 'vsd.import', since })).filter(
      (e) => e.payload.data.batchId === res.body.id,
    );
    expect(events.length).toBe(1);
    expect((await settled(farm.client, res.body.id)).importStatus).toBe('NOT_FOUND');
  });

  it('Mercury failing: 6 calls, then FAILED; the batch is created all the same; the retry runs the cycle again', async () => {
    const productId = await failingProduct();
    const res = await createBatch(farm.client, {
      fieldId: farm.field.id,
      productId,
      massKg: '50.000',
      harvestedAt: daysAgo(1),
    });
    expect(res.status, res.text).toBe(201);
    const vsd = await settled(farm.client, res.body.id, 60000);
    expect(vsd).toMatchObject({ importStatus: 'FAILED', document: null, attempts: 6 });
    const r = await retry(farm.client, res.body.id);
    expect(r.status, r.text).toBe(202);
    expect(r.body.attempts).toBe(0);
    expect((await settled(farm.client, res.body.id, 60000)).importStatus).toBe('FAILED');
  }, 150000);

  it('worker concurrency (R92, P56): imports queued behind a running one never hold back a later notification', async () => {
    // Eight imports that fail (6 Mercury calls each, about 1.6 s on the stand) are queued, then a waybill is sent.
    // A busy vsd.import must be settled at once and re-scheduled (P56), so WAYBILL_INCOMING arrives within seconds
    // while most imports still wait. The old requeue-to-head algorithm held it until all but one had run (≈ 11 s).
    const productId = await failingProduct();
    const processor = await freshOrg('PROCESSOR');
    const shipped = await approvedBatch(farm);
    const draft = await createWaybill(farm.client, {
      receiverOrgId: processor.orgId,
      items: [{ batchId: shipped.id, massDeclaredKg: shipped.massKg }],
    });
    expect(draft.status, draft.text).toBe(201);
    const imports = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const r = await createBatch(farm.client, {
          fieldId: farm.field.id,
          productId,
          massKg: '10.000',
          harvestedAt: daysAgo(1),
        });
        expect(r.status, r.text).toBe(201);
        return r.body.id as string;
      }),
    );
    const sent = await sendWaybill(farm.client, draft.body);
    expect(sent.status, sent.text).toBe(200);
    const t0 = Date.now();
    await eventually(
      async () => {
        const res = await processor.client.get('/notifications', {
          query: { type: 'WAYBILL_INCOMING', size: 100 },
        });
        await expectContract(res, 'listNotifications');
        return (res.body.items as { payload: { waybillId: string } }[]).find(
          (n) => n.payload.waybillId === draft.body.id,
        );
      },
      30000,
      100,
    );
    const elapsed = Date.now() - t0;
    const pending = (
      await Promise.all(imports.map(async (id) => (await documents(farm.client, id)).body.vsd.importStatus))
    ).filter((s) => s === 'PENDING').length;
    expect(pending, 'imports still queued or running when the notification arrived').toBeGreaterThanOrEqual(
      3,
    );
    expect(elapsed, 'WAYBILL_INCOMING delivered while vsd.import was busy').toBeLessThan(5000);
    // Every re-scheduled import still runs to its end (nothing lost, each its 6 calls).
    for (const id of imports)
      expect(await settled(farm.client, id, 120000)).toMatchObject({ importStatus: 'FAILED', attempts: 6 });
  }, 240000);

  it('retry: x-roles FARMER/PROCESSOR, Idempotency-Key required, 403 NOT_HOLDER, 404 without VSD', async () => {
    const plain = await approvedBatch(farm, { productId: (await wheat()).id });
    expectProblem(await retry(farm.client, plain.id), 404, 'NOT_FOUND');
    for (const role of ['RETAILER', 'LAB', 'INSPECTOR', 'ADMIN'] as const)
      expectProblem(await retry(await loginAs(role), plain.id), 403, 'FORBIDDEN', null);
    const missing = await farm.client.post(`/batches/${plain.id}/documents/vsd/retry`);
    await expectContract(missing, 'retryBatchVsdImport');
    expectProblem(missing, 400, 'INVALID_IDEMPOTENCY_KEY');
    expectProblem(await retry(farm.client, plain.id, 'short'), 400, 'INVALID_IDEMPOTENCY_KEY');

    const meat = await approvedBatch(farm, { productId: (await beef()).id, harvestedAt: daysAgo(2) });
    await settled(farm.client, meat.id);
    const processor = await freshOrg('PROCESSOR');
    await deliver(farm.client, processor, meat);
    expectProblem(await retry(farm.client, meat.id), 403, 'FORBIDDEN', { reason: 'NOT_HOLDER' });
    const r = await retry(processor.client, meat.id);
    expect(r.status, r.text).toBe(202);
  });
});
