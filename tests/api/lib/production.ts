/**
 * Production-flow fixtures through the API (fields, batches, waybills): suites that move batches create their own
 * fields, batches, receivers and waybills, so they stay independent and re-runnable after `./at.sh reset`.
 *
 * Batches in Approved: the risk model (BR-03) skips the lab test only for an experienced farm (≥ 5 raw batches,
 * trust rating ≥ 70, no recent pesticide treatment on the field) outside the 20% hash sample — the seeded farm
 * «КФХ Петров» (key `petrov`) on a fresh field; `approvedBatch` retries the 20% sample. Lab results (OnTest → Approved)
 * arrive with Task 9.
 */
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { loginAs } from './auth.js';
import type { ApiClient } from './client.js';
import { expectContract } from './contract.js';
import { freshHead } from './fixtures.js';

export const PETROV = 'petrov';

export interface Product {
  id: string;
  name: string;
  category: string;
  lossNormPercent: string;
  mercuryCode: string | null;
}

/** An Idempotency-Key matching ^[A-Za-z0-9_-]{8,128}$. */
export const idemKey = (): string => `k-${randomBytes(12).toString('hex')}`;

const iso = (ms: number) => new Date(ms).toISOString();
/** An instant `days` ago (UTC). */
export const daysAgo = (days: number): string => iso(Date.now() - days * 86_400_000);

let productCache: Promise<Product[]> | null = null;
export function products(): Promise<Product[]> {
  productCache ??= (async () => {
    const client = await loginAs('ADMIN', { head: true });
    const out: Product[] = [];
    for (let page = 1; ; page++) {
      const res = await client.get('/dictionaries/products', { query: { size: 100, page } });
      await expectContract(res, 'listDictionary');
      out.push(...(res.body.items as Product[]));
      if (out.length >= res.body.total || res.body.items.length === 0) return out;
    }
  })();
  return productCache;
}

export async function productOf(pred: (p: Product) => boolean): Promise<Product> {
  const p = (await products()).find(pred);
  if (!p) throw new Error('no such seeded product');
  return p;
}

/** The seeded wheat (db/seed/data/products.json; other suites add GRAIN products of their own). */
export const wheat = () => productOf((p) => p.category === 'GRAIN' && p.name === 'Пшеница мягкая');
export const beef = () => productOf((p) => p.category === 'MEAT' && p.mercuryCode === '10.11.11');

/** createField on `farm` (a fresh field: no treatments). */
export async function newField(
  farm: ApiClient,
  name = 'Тестовый участок',
): Promise<{ id: string; name: string }> {
  const res = await farm.post('/fields', {
    name: `${name} ${randomBytes(2).toString('hex')}`,
    areaHa: '10.00',
    regionCode: '33',
  });
  await expectContract(res, 'createField');
  expect(res.status, res.text).toBe(201);
  return res.body;
}

export async function createBatch(farm: ApiClient, body: Record<string, unknown>) {
  const res = await farm.post('/batches', body);
  await expectContract(res, 'createBatch');
  return res;
}

export interface Farm {
  client: ApiClient;
  field: { id: string; name: string };
  orgId: string;
}

let petrovFarm: Promise<Farm> | null = null;
/** «КФХ Петров» with one fresh field (shared by a test file). */
export function petrov(): Promise<Farm> {
  petrovFarm ??= (async () => {
    const client = await loginAs('FARMER', { key: PETROV });
    const me = await client.get('/me');
    await expectContract(me, 'getMe');
    return { client, field: await newField(client), orgId: me.body.organization.id as string };
  })();
  return petrovFarm;
}

/** A batch of the farm in Approved (retries the 20% sample, which goes OnTest). */
export async function approvedBatch(
  farm: Farm,
  over: { productId?: string; massKg?: string; harvestedAt?: string } = {},
) {
  const productId = over.productId ?? (await wheat()).id;
  for (let i = 0; i < 15; i++) {
    const res = await createBatch(farm.client, {
      fieldId: farm.field.id,
      productId,
      massKg: over.massKg ?? '1000.000',
      harvestedAt: over.harvestedAt ?? daysAgo(1),
    });
    expect(res.status, res.text).toBe(201);
    if (res.body.status === 'Approved') return res.body;
  }
  throw new Error('no Approved batch after 15 attempts');
}

/** A fresh active organization (head signed in) of `type` with its id. */
export async function freshOrg(type: 'PROCESSOR' | 'RETAILER' | 'FARM') {
  const h = await freshHead(type);
  return { client: h.client, orgId: h.org.organizationId, userId: h.user.id };
}

export async function createWaybill(
  sender: ApiClient,
  body: Record<string, unknown>,
  key: string = idemKey(),
) {
  const res = await sender.post('/waybills', body, { headers: { 'Idempotency-Key': key } });
  await expectContract(res, 'createWaybill');
  return res;
}

export async function sendWaybill(
  sender: ApiClient,
  wb: { id: string; version: number },
  key: string = idemKey(),
) {
  const res = await sender.post(`/waybills/${wb.id}/send`, undefined, {
    headers: { 'Idempotency-Key': key, 'If-Match': String(wb.version) },
  });
  await expectContract(res, 'sendWaybill');
  return res;
}

export async function acceptWaybill(
  receiver: ApiClient,
  wb: { id: string; version: number },
  items: { batchId: string; massActualKg: string; discrepancyAct?: string }[],
  key: string = idemKey(),
) {
  const res = await receiver.post(
    `/waybills/${wb.id}/accept`,
    { items },
    {
      headers: { 'Idempotency-Key': key, 'If-Match': String(wb.version) },
    },
  );
  await expectContract(res, 'acceptWaybill');
  return res;
}

export async function rejectWaybill(
  receiver: ApiClient,
  wb: { id: string; version: number },
  reason: string,
) {
  const res = await receiver.post(
    `/waybills/${wb.id}/reject`,
    { reason },
    {
      headers: { 'If-Match': String(wb.version) },
    },
  );
  await expectContract(res, 'rejectWaybill');
  return res;
}

/** A SENT waybill of `batches` from `farm` to `receiverOrgId` (declared = current mass). */
export async function sentWaybill(
  sender: ApiClient,
  receiverOrgId: string,
  batches: { id: string; massKg: string }[],
) {
  const draft = await createWaybill(sender, {
    receiverOrgId,
    items: batches.map((b) => ({ batchId: b.id, massDeclaredKg: b.massKg })),
  });
  expect(draft.status, draft.text).toBe(201);
  const sent = await sendWaybill(sender, draft.body);
  expect(sent.status, sent.text).toBe(200);
  return sent.body;
}

/** Ships `batch` from `sender` to the receiver and accepts it with the declared mass; returns the accepted waybill. */
export async function deliver(
  sender: ApiClient,
  receiver: { client: ApiClient; orgId: string },
  batch: { id: string; massKg: string },
) {
  const sent = await sentWaybill(sender, receiver.orgId, [batch]);
  const res = await acceptWaybill(receiver.client, sent, [{ batchId: batch.id, massActualKg: batch.massKg }]);
  expect(res.status, res.text).toBe(200);
  return res.body;
}

export async function getBatch(client: ApiClient, id: string) {
  const res = await client.get(`/batches/${id}`);
  await expectContract(res, 'getBatch');
  return res;
}

/** Polls `fn` until it returns a value (not undefined) or the timeout passes. */
export async function eventually<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 20000,
  stepMs = 250,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const flour = () =>
  productOf((p) => p.category === 'PROCESSED' && p.name === 'Мука пшеничная высшего сорта');

/** processBatches (POST /processing). */
export async function processBatches(
  processor: ApiClient,
  inputs: { batchId: string; massUsedKg: string }[],
  outputs: { productId: string; massKg: string }[],
) {
  const res = await processor.post('/processing', { inputs, outputs });
  await expectContract(res, 'processBatches');
  return res;
}

/** A batch of `farm` delivered to `processor` (Accepted, held by the processor). */
export async function acceptedAt(
  farm: Farm,
  processor: { client: ApiClient; orgId: string },
  over: { productId?: string; massKg?: string } = {},
) {
  const b = await approvedBatch(farm, over);
  await deliver(farm.client, processor, b);
  const card = await getBatch(processor.client, b.id);
  expect(card.body.status).toBe('Accepted');
  return card.body as { id: string; publicCode: string; massKg: string; version: number; status: string };
}

/** Exact masses in grams (BigInt), as the contract computes BR-04. */
export const grams = (kg: string): bigint => {
  const [i, f = ''] = kg.split('.');
  return BigInt(i!) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3));
};
export const kg = (g: bigint): string => `${g / 1000n}.${String(g % 1000n).padStart(3, '0')}`;
