/**
 * Quality fixtures through the API (lab tests, recalls, recall tasks, the trust rating): Tasks 10–11.
 *
 * The trust rating (BR-09) is recomputed asynchronously from every DONE lab test and every recall whose source batch
 * a farm created. A FAIL or a recall on a batch of the seeded farm «КФХ Петров» would lower its rating below 70 and
 * send its later batches on test (BR-03 LOW_RATING), breaking the suites that rely on `approvedBatch(petrov())`.
 * Recall sources of raw batches therefore always belong to a fresh farm: `labApproved` brings its batch to Approved
 * through an INSPECTOR test of a seeded laboratory with a PASS (OnTest → Approved, LAB_PASS).
 */
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { loginAs } from './auth.js';
import type { ApiClient } from './client.js';
import { expectContract } from './contract.js';
import { createBatch, daysAgo, freshOrg, getBatch, newField, wheat } from './production.js';

export interface FreshFarm {
  client: ApiClient;
  orgId: string;
  field: { id: string; name: string };
}

/** A fresh active farm (head signed in) with one fresh field; its rating starts at 80. */
export async function freshFarm(): Promise<FreshFarm> {
  const f = await freshOrg('FARM');
  return { client: f.client, orgId: f.orgId, field: await newField(f.client) };
}

let seededLab: Promise<{ client: ApiClient; orgId: string }> | null = null;
/** The seeded laboratory «vetlab» (its head). */
export function vetlab(): Promise<{ client: ApiClient; orgId: string }> {
  seededLab ??= (async () => {
    const client = await loginAs('LAB', { key: 'vetlab.head' });
    const me = await client.get('/me');
    await expectContract(me, 'getMe');
    return { client, orgId: me.body.organization.id as string };
  })();
  return seededLab;
}

let inspectorClient: Promise<ApiClient> | null = null;
export function inspector(): Promise<ApiClient> {
  inspectorClient ??= loginAs('INSPECTOR');
  return inspectorClient;
}

export interface LabTestRef {
  id: string;
  norms: { indicatorId: string }[];
  version: number;
}

/** createLabTest by the inspector in the seeded laboratory. */
export async function inspectorTest(batchId: string): Promise<LabTestRef> {
  const lab = await vetlab();
  const res = await (await inspector()).post('/lab-tests', { batchId, labOrgId: lab.orgId });
  await expectContract(res, 'createLabTest');
  expect(res.status, res.text).toBe(201);
  return res.body as LabTestRef;
}

/** submitLabResults by the seeded laboratory: every norm at `value` ('0' → PASS, '99999' → FAIL). */
export async function submitAll(test: LabTestRef, value: string) {
  const lab = await vetlab();
  const res = await lab.client.post(
    `/lab-tests/${test.id}/results`,
    { results: test.norms.map((n) => ({ indicatorId: n.indicatorId, value })) },
    { headers: { 'If-Match': String(test.version) } },
  );
  await expectContract(res, 'submitLabResults');
  expect(res.status, res.text).toBe(200);
  return res.body as { id: string; conclusion: string; recallId: string | null };
}

export interface BatchRef {
  id: string;
  publicCode: string;
  massKg: string;
  status: string;
  version: number;
}

/** A raw wheat batch of `farm` (any status the risk model gives it). */
export async function rawBatch(farm: FreshFarm, massKg = '1000.000'): Promise<BatchRef> {
  const res = await createBatch(farm.client, {
    fieldId: farm.field.id,
    productId: (await wheat()).id,
    massKg,
    harvestedAt: daysAgo(1),
  });
  expect(res.status, res.text).toBe(201);
  return res.body as BatchRef;
}

/** A raw batch of `farm` in Approved: on test → an inspector test PASS (OnTest → Approved). */
export async function labApproved(farm: FreshFarm, massKg = '1000.000'): Promise<BatchRef> {
  const b = await rawBatch(farm, massKg);
  if (b.status !== 'Approved') {
    expect(b.status).toBe('OnTest');
    await submitAll(await inspectorTest(b.id), '0');
  }
  const card = await getBatch(farm.client, b.id);
  expect(card.body.status, card.text).toBe('Approved');
  return card.body as BatchRef;
}

export const rand = (): string => randomBytes(3).toString('hex');

// ── recall API ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function createRecall(client: ApiClient, body: unknown) {
  const res = await client.post('/recalls', body);
  await expectContract(res, 'createRecall');
  return res;
}

export async function getRecall(client: ApiClient, id: string) {
  const res = await client.get(`/recalls/${id}`);
  await expectContract(res, 'getRecall');
  return res;
}

export async function listRecalls(client: ApiClient, query: Record<string, string | number | boolean> = {}) {
  const res = await client.get('/recalls', { query });
  await expectContract(res, 'listRecalls');
  return res;
}

export async function listRecallTasks(
  client: ApiClient,
  query: Record<string, string | number | boolean> = {},
) {
  const res = await client.get('/recall-tasks', { query });
  await expectContract(res, 'listRecallTasks');
  return res;
}

export async function confirmTask(
  client: ApiClient,
  id: string,
  version: number | undefined,
  opts: { key?: string | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (version !== undefined) headers['If-Match'] = String(version);
  if (opts.key !== null) headers['Idempotency-Key'] = opts.key ?? `k-${randomBytes(12).toString('hex')}`;
  const res = await client.post(`/recall-tasks/${id}/confirm`, opts.body, { headers });
  await expectContract(res, 'confirmRecallTask');
  return res;
}

/** The farm's current trust rating (getOrganization as the inspector). */
export async function trustRating(orgId: string): Promise<number | null> {
  const res = await (await inspector()).get(`/organizations/${orgId}`);
  await expectContract(res, 'getOrganization');
  expect(res.status, res.text).toBe(200);
  return res.body.trustRating as number | null;
}
