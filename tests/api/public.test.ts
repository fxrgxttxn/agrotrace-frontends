/**
 * The public part (contracts/openapi/paths/public.yaml; FR-PUB-01…03, R82, P9): the QR page of a batch
 * (`getPublicBatch` — product, origin, region, dates, path by the R45 rule, labSummary, safety; no personal data; the
 * shared Redis cache `pub:batch:{publicCode}` for 5 minutes, served byte for byte and dropped when the page's data
 * changes) and the ALTCHA challenge (`getCaptchaChallenge`, Cache-Control: no-store, signed with the shared key).
 * Complaints themselves — complaints.test.ts. Everything here runs without signing in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { altchaSignature, challenge, solve, type AltchaChallenge } from './lib/altcha.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { approvedBatch, deliver, freshOrg, getBatch, petrov, wheat, type Farm } from './lib/production.js';
import {
  confirmTask,
  createRecall,
  freshFarm,
  inspector as inspectorOf,
  labApproved,
  rawBatch,
} from './lib/quality.js';
import { closeRedis, redis } from './lib/redis.js';
import { instant, instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

async function publicBatch(client: ApiClient, code: string) {
  const res = await client.get(`/public/batches/${code}`);
  await expectContract(res, 'getPublicBatch');
  return res;
}

let inspector: ApiClient;
let farm: Farm;
beforeAll(async () => {
  inspector = await inspectorOf();
  farm = await petrov();
});

describe('getPublicBatch', () => {
  it('without signing in: the publicCode pattern (400), unknown → 404', async () => {
    expectErrors(await publicBatch(api(), 'AT-26-1'), { publicCode: ['validation.pattern'] });
    expectProblem(await publicBatch(api(), 'AT-2026-999999999'), 404, 'NOT_FOUND');
  });

  it('the page of a delivered batch: product, origin and its region, dates, the path (R45 rule), labSummary, safety; no personal data', async () => {
    const retailer = await freshOrg('RETAILER');
    const b = await approvedBatch(farm);
    await deliver(farm.client, retailer, b);
    const res = await publicBatch(api(), b.publicCode);
    expect(res.status, res.text).toBe(200);
    expect(res.contentType).toBe('application/json');
    const card = (await getBatch(retailer.client, b.id)).body;
    const origin = (await inspector.get(`/organizations/${farm.orgId}`)).body;
    const path = (await retailer.client.get(`/batches/${b.id}/path`)).body as {
      org: { name: string; type: string; logoUrl: string | null };
      from: string;
      to: string | null;
    }[];
    expect(path.length).toBe(2);
    const product = await wheat();
    expect(instants(res.body)).toEqual(
      instants({
        publicCode: b.publicCode,
        product: { name: product.name, category: product.category, imageUrl: card.product.imageUrl },
        origin: { farmName: origin.name, logoUrl: origin.logoUrl, region: origin.region },
        harvestedAt: card.harvestedAt,
        producedAt: null,
        status: 'Accepted',
        safety: 'SAFE',
        path: path.map((s) => ({
          orgName: s.org.name,
          orgType: s.org.type,
          logoUrl: s.org.logoUrl,
          from: s.from,
          to: s.to,
        })),
        labSummary: { total: 0, passed: 0, lastConclusion: null, lastDate: null },
      }),
    );
    // No personal data: no e-mail addresses or people's names of the participants.
    expect(res.text).not.toMatch(/@/);
  });

  it('safety by status: OnTest → UNKNOWN; Approved by a PASS → SAFE with labSummary; Recalled, WrittenOff → RECALLED', async () => {
    const fresh = await freshFarm();
    const onTest = await rawBatch(fresh);
    expect(onTest.status).toBe('OnTest');
    expect((await publicBatch(api(), onTest.publicCode)).body).toMatchObject({
      status: 'OnTest',
      safety: 'UNKNOWN',
    });
    const b = await labApproved(fresh);
    const page = (await publicBatch(api(), b.publicCode)).body;
    expect(page).toMatchObject({
      status: 'Approved',
      safety: 'SAFE',
      labSummary: { total: 1, passed: 1, lastConclusion: 'PASS' },
    });
    const tests = (await inspector.get('/lab-tests', { query: { batchId: b.id, status: 'DONE' } })).body
      .items as {
      completedAt: string;
    }[];
    expect(instant(page.labSummary.lastDate)).toBe(instant(tests[0]!.completedAt));
    const r = await createRecall(inspector, {
      sourceBatchId: b.id,
      reason: 'Проверка страницы',
      blockUpstream: false,
    });
    expect(r.status, r.text).toBe(201);
    expect((await publicBatch(api(), b.publicCode)).body).toMatchObject({
      status: 'Recalled',
      safety: 'RECALLED',
    });
    const task = r.body.tasks[0] as { id: string; version: number };
    const ok = await confirmTask(fresh.client, task.id, task.version);
    expect(ok.status, ok.text).toBe(200);
    expect((await publicBatch(api(), b.publicCode)).body).toMatchObject({
      status: 'WrittenOff',
      safety: 'RECALLED',
    });
  });

  it('cache (R82): the exact JSON in pub:batch:{publicCode} for 300 s, a hit serves the stored bytes as is, a status change drops it', async () => {
    const fresh = await freshFarm();
    const b = await labApproved(fresh);
    const key = `pub:batch:${b.publicCode}`;
    await redis().del(key);
    const first = await publicBatch(api(), b.publicCode);
    expect(first.status).toBe(200);
    expect(await redis().get(key)).toBe(first.text);
    const ttl = await redis().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    // A hit is served without re-reading the DB or re-serializing: a stored variant comes back byte for byte.
    const variant = JSON.stringify(
      { ...first.body, product: { ...first.body.product, name: 'Из кэша' } },
      null,
      1,
    );
    await redis().set(key, variant, 'EX', 300);
    const hit = await publicBatch(api(), b.publicCode);
    expect(hit.text).toBe(variant);
    // Any change of the page's data drops the key after the commit (here: the recall cascade).
    const r = await createRecall(inspector, {
      sourceBatchId: b.id,
      reason: 'Сброс кэша',
      blockUpstream: false,
    });
    expect(r.status, r.text).toBe(201);
    expect(await redis().exists(key)).toBe(0);
    const fresh2 = await publicBatch(api(), b.publicCode);
    expect(fresh2.body).toMatchObject({ status: 'Recalled', product: { name: first.body.product.name } });
  });
});

describe('getCaptchaChallenge', () => {
  it('a signed SHA-256 challenge valid for 10 minutes, Cache-Control: no-store, solvable within maxnumber', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await challenge(api());
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const c = res.body as AltchaChallenge;
    expect(c.algorithm).toBe('SHA-256');
    const m = /^[0-9a-f]+\?expires=(\d+)$/.exec(c.salt);
    expect(m, c.salt).not.toBeNull();
    const expires = Number(m![1]);
    expect(expires).toBeGreaterThanOrEqual(before + 600 - 5);
    expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600 + 5);
    expect(c.signature).toBe(altchaSignature(c.challenge));
    expect(() => solve(c)).not.toThrow();
    const other = (await challenge(api())).body as AltchaChallenge;
    expect(other.challenge).not.toBe(c.challenge);
  });
});
