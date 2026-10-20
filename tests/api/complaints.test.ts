/**
 * Buyer complaints (contracts/openapi/paths/public.yaml createPublicComplaint, paths/complaints.yaml; БП-6, FR-PUB-03,
 * FR-QA-08, R30, P10, R54/D15): creation without signing in (ALTCHA: a wrong, forged, expired or reused solution →
 * 400 CAPTCHA_FAILED; the `complaint-ip` limit of 10 per hour, honouring RATE_LIMIT_OVERRIDES), COMPLAINT to the
 * inspectors, the inspector's list and card, review (NEW → IN_REVIEW) and the final decision (entity-state-machines.json
 * `complaint`): REJECT, LAB_TEST (an unplanned test, reason COMPLAINT, in `labOrgId`), RECALL (the engine with trigger
 * COMPLAINT; an OPEN recall of the batch is reused).
 *
 * Batches of fresh farms (lib/quality.ts): a RECALL decision lowers the source farm's rating (BR-09).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forge, solution, altchaKey } from './lib/altcha.js';
import { loginAs, type Role } from './lib/auth.js';
import { auditEntries } from './lib/audit.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, dbNow, outboxEvents } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { deliver, flour, freshOrg, processBatches, wheat } from './lib/production.js';
import {
  freshFarm,
  getRecall,
  inspector as inspectorOf,
  labApproved,
  rand,
  vetlab,
  type BatchRef,
  type FreshFarm,
} from './lib/quality.js';
import { awayFromWindowEdge, closeRedis, redis, windowStart } from './lib/redis.js';
import { itRateLimit } from './lib/tags.js';
import { instant } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const BACKEND = process.env.API_BACKEND ?? 'express';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;

interface Complaint {
  id: string;
  batch: { id: string; publicCode: string };
  text: string;
  status: string;
  decision: string | null;
  createdAt: string;
  decidedAt: string | null;
  contact: string | null;
  decisionComment: string | null;
  inspector: { id: string; fullName: string } | null;
  labTestId: string | null;
  recallId: string | null;
}

async function complain(client: ApiClient, code: string, body: unknown) {
  const res = await client.post(`/public/batches/${code}/complaints`, body);
  await expectContract(res, 'createPublicComplaint');
  return res;
}

const text = () => `Горечь во рту после употребления, партия ${rand()}`;

/** A complaint (NEW) on `b` from a fresh anonymous buyer. */
async function newComplaint(
  b: { publicCode: string },
  contact?: string,
): Promise<{ id: string; createdAt: string }> {
  const buyer = api();
  const res = await complain(buyer, b.publicCode, {
    text: text(),
    ...(contact && { contact }),
    altcha: await solution(buyer),
  });
  expect(res.status, res.text).toBe(201);
  return res.body;
}

async function getComplaint(client: ApiClient, id: string) {
  const res = await client.get(`/complaints/${id}`);
  await expectContract(res, 'getComplaint');
  return res;
}
async function review(client: ApiClient, id: string, body?: unknown) {
  const res = await client.post(`/complaints/${id}/review`, body);
  await expectContract(res, 'startComplaintReview');
  return res;
}
async function decide(client: ApiClient, id: string, body: unknown) {
  const res = await client.post(`/complaints/${id}/decision`, body);
  await expectContract(res, 'decideComplaint');
  return res;
}

let inspector: ApiClient;
let inspectorId: string;
let farm: FreshFarm;
let batch: BatchRef;
beforeAll(async () => {
  inspector = await inspectorOf();
  inspectorId = (await inspector.get('/me')).body.id as string;
  farm = await freshFarm();
  batch = await labApproved(farm);
});

describe('createPublicComplaint', () => {
  it('without signing in: 201 {id, createdAt}; NEW with the contact; COMPLAINT to the inspectors; audit without an actor', async () => {
    const since = await dbNow();
    const buyer = api();
    const body = { text: text(), contact: '+79161234567', altcha: await solution(buyer) };
    const res = await complain(buyer, batch.publicCode, body);
    expect(res.status, res.text).toBe(201);
    const c = (await getComplaint(inspector, res.body.id)).body as Complaint;
    expect(c).toMatchObject({
      id: res.body.id,
      batch: { id: batch.id, publicCode: batch.publicCode },
      text: body.text,
      status: 'NEW',
      decision: null,
      decidedAt: null,
      contact: '+79161234567',
      decisionComment: null,
      inspector: null,
      labTestId: null,
      recallId: null,
    });
    expect(instant(c.createdAt)).toBe(instant(res.body.createdAt));
    const notes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.notificationType === 'COMPLAINT' && d.payload.complaintId === c.id);
    expect(notes).toEqual([
      {
        notificationType: 'COMPLAINT',
        recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          complaintId: c.id,
          batchId: batch.id,
          publicCode: batch.publicCode,
          productName: (await wheat()).name,
        },
      },
    ]);
    const audit = await auditEntries({ entityType: 'complaint', entityId: c.id });
    expect(audit.map((e) => [e.action, e.actor, e.diff.status])).toEqual([
      ['createPublicComplaint', null, [null, 'NEW']],
    ]);
    expect(audit[0]!.ip).toBe(buyer.clientIp);
    // Without a contact: null.
    const plain = await newComplaint(batch);
    expect((await getComplaint(inspector, plain.id)).body.contact).toBeNull();
  });

  it('body by schema (with the publicCode pattern in the same 400); unknown batch → 404 and the solution stays usable', async () => {
    const buyer = api();
    expectErrors(await complain(buyer, batch.publicCode, {}), {
      text: ['validation.required'],
      altcha: ['validation.required'],
    });
    expectErrors(await complain(buyer, 'AT-1', { text: 'коротко', altcha: 'x', extra: 1 }), {
      publicCode: ['validation.pattern'],
      text: ['validation.minLength'],
      extra: ['validation.unknownField'],
    });
    expectErrors(await complain(buyer, batch.publicCode, { text: ' '.repeat(12), altcha: 'x' }), {
      text: ['validation.pattern'],
    });
    const s = await solution(buyer);
    expectProblem(await complain(buyer, 'AT-2026-999999999', { text: text(), altcha: s }), 404, 'NOT_FOUND');
    const ok = await complain(buyer, batch.publicCode, { text: text(), altcha: s });
    expect(ok.status, ok.text).toBe(201);
  });

  it('ALTCHA: reused, wrong number, tampered signature, expired, another key, not base64-JSON → 400 CAPTCHA_FAILED', async () => {
    const buyer = api();
    const s = await solution(buyer);
    expect((await complain(buyer, batch.publicCode, { text: text(), altcha: s })).status).toBe(201);
    const failed = async (altcha: string) =>
      expectProblem(await complain(buyer, batch.publicCode, { text: text(), altcha }), 400, 'CAPTCHA_FAILED');
    await failed(s); // reused
    // Step 5: two parallel complaints with one fresh solution — exactly one wins the SET NX.
    const twin = await solution(buyer);
    const pair = await Promise.all([
      complain(api(), batch.publicCode, { text: text(), altcha: twin }),
      complain(api(), batch.publicCode, { text: text(), altcha: twin }),
    ]);
    expect(pair.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(pair.find((r) => r.status === 400)!.body.code).toBe('CAPTCHA_FAILED');
    const decoded = JSON.parse(Buffer.from(await solution(buyer), 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    const enc = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v)).toString('base64');
    await failed(enc({ ...decoded, number: (decoded.number as number) + 1 }));
    await failed(enc({ ...decoded, signature: 'a'.repeat(64) }));
    await failed(forge({ expiresSec: Math.floor(Date.now() / 1000) - 1 }));
    await failed(
      forge({
        expiresSec: Math.floor(Date.now() / 1000) + 600,
        key: altchaKey('another-secret-of-at-least-32-chars!!'),
      }),
    );
    await failed('not-base64-json');
    // A correctly signed, unexpired solution made with the shared key is accepted (any backend issues it).
    const forged = forge({ expiresSec: Math.floor(Date.now() / 1000) + 600 });
    expect((await complain(buyer, batch.publicCode, { text: text(), altcha: forged })).status).toBe(201);
    expect(
      await redis().exists(`altcha-used:${JSON.parse(Buffer.from(forged, 'base64').toString()).signature}`),
    ).toBe(1);
  });

  it('RATE_LIMIT_OVERRIDES (P10): the test stand replaces the complaint-ip limit — 11 requests from one address are not limited', async () => {
    const buyer = api();
    for (let i = 0; i < 11; i++)
      expectErrors(await complain(buyer, batch.publicCode, {}), {
        text: ['validation.required'],
        altcha: ['validation.required'],
      });
  });

  itRateLimit(
    'complaint-ip: the 11th request from one IP within the hour → 429 with Retry-After and params',
    async () => {
      await awayFromWindowEdge(3600, 30);
      const buyer = api();
      // The limit is counted first (before the body): invalid bodies count too.
      for (let i = 0; i < 10; i++) expect((await complain(buyer, batch.publicCode, {})).status).toBe(400);
      const limited = await complain(buyer, batch.publicCode, { text: text(), altcha: 'x' });
      expectProblem(limited, 429, 'RATE_LIMITED', { scope: 'complaint-ip', limit: 10, windowSec: 3600 });
      const retry = Number(limited.headers.get('retry-after'));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(3600);
      expect(Number(await redis().get(`rl:complaint-ip:${buyer.clientIp}:${windowStart(3600)}`))).toBe(11);
      // Another address is not affected.
      expect((await complain(api(), batch.publicCode, {})).status).toBe(400);
    },
  );
});

describe('listComplaints, getComplaint', () => {
  it('only INSPECTOR; filters status, decision, batchId, q (publicCode or text), from/to by the UTC date of createdAt; x-sort', async () => {
    for (const role of ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'ADMIN'] as Role[]) {
      const c = await loginAs(role);
      const l = await c.get('/complaints');
      await expectContract(l, 'listComplaints');
      expectProblem(l, 403, 'FORBIDDEN', null);
      expectProblem(await getComplaint(c, UUID0), 403, 'FORBIDDEN', null);
    }
    expectProblem(await getComplaint(inspector, UUID0), 404, 'NOT_FOUND');
    const b = await labApproved(farm);
    const first = await newComplaint(b);
    const second = await newComplaint(b);
    const rejected = await decide(inspector, second.id, {
      decision: 'REJECT',
      comment: 'Не связано с качеством',
    });
    expect(rejected.status, rejected.text).toBe(200);
    const ids = async (q: string) => {
      const res = await inspector.get(`/complaints?size=100&${q}`);
      await expectContract(res, 'listComplaints');
      expect(res.status, res.text).toBe(200);
      return (res.body.items as Complaint[]).map((x) => x.id);
    };
    expect(await ids(`batchId=${b.id}`)).toEqual([second.id, first.id]); // createdAt,desc
    expect(await ids(`batchId=${b.id}&sort=createdAt,asc`)).toEqual([first.id, second.id]);
    expect(await ids(`batchId=${b.id}&sort=decidedAt,desc`)).toEqual([second.id, first.id]); // nulls last
    expect(await ids(`batchId=${b.id}&status=NEW`)).toEqual([first.id]);
    expect(await ids(`batchId=${b.id}&status=NEW&status=DECIDED`)).toEqual([second.id, first.id]);
    expect(await ids(`batchId=${b.id}&decision=REJECT`)).toEqual([second.id]);
    expect(await ids(`batchId=${b.id}&decision=LAB_TEST&decision=RECALL`)).toEqual([]);
    expect(await ids(`q=${b.publicCode.toLowerCase()}`)).toEqual([second.id, first.id]);
    const own = (await getComplaint(inspector, first.id)).body as Complaint;
    expect(await ids(`q=${encodeURIComponent(own.text.slice(-6).toUpperCase())}`)).toContain(first.id);
    const day = first.createdAt.slice(0, 10);
    const next = new Date(instant(second.createdAt) + DAY).toISOString().slice(0, 10);
    expect(await ids(`batchId=${b.id}&from=${day}&to=${second.createdAt.slice(0, 10)}`)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await ids(`batchId=${b.id}&from=${next}`)).toEqual([]);
    const listed = (await inspector.get('/complaints', { query: { batchId: b.id, status: 'NEW' } })).body
      .items[0];
    expect(Object.keys(listed).sort()).toEqual([
      'batch',
      'createdAt',
      'decidedAt',
      'decision',
      'id',
      'status',
      'text',
    ]);
    const bad = await inspector.get('/complaints?status=OPEN&decision=X&sort=text,asc&batchId=x');
    await expectContract(bad, 'listComplaints');
    expectErrors(bad, {
      status: ['validation.enum'],
      decision: ['validation.enum'],
      sort: ['validation.sort'],
      batchId: ['validation.uuid'],
    });
  });
});

describe('startComplaintReview', () => {
  it('NEW → IN_REVIEW with the inspector; again → 409 {from: IN_REVIEW, to: IN_REVIEW}; body {} only; 404; roles', async () => {
    const c = await newComplaint(batch);
    expectProblem(await review(await loginAs('ADMIN'), c.id), 403, 'FORBIDDEN', null);
    expectErrors(await review(inspector, c.id, { note: 1 }), { note: ['validation.unknownField'] });
    expectProblem(await review(inspector, UUID0), 404, 'NOT_FOUND');
    const res = await review(inspector, c.id, {});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      id: c.id,
      status: 'IN_REVIEW',
      inspector: { id: inspectorId },
      decision: null,
    });
    expectProblem(await review(inspector, c.id), 409, 'INVALID_TRANSITION', {
      from: 'IN_REVIEW',
      to: 'IN_REVIEW',
    });
    const audit = await auditEntries({ entityType: 'complaint', entityId: c.id });
    expect(audit.at(-1)).toMatchObject({
      action: 'startComplaintReview',
      diff: { status: ['NEW', 'IN_REVIEW'] },
    });
  });
});

describe('decideComplaint', () => {
  it('body by schema: labOrgId only and always with LAB_TEST, blockUpstream only with RECALL; the comment', async () => {
    const c = await newComplaint(batch);
    // P44: a oneOf body without its discriminator — `decision` must be reported; other fields required in every
    // variant (`comment`) may be reported too.
    const none = await decide(inspector, c.id, {});
    expectProblem(none, 400, 'VALIDATION');
    expect(none.body.errors.decision).toContain('validation.required');
    expect(Object.keys(none.body.errors).filter((k) => k !== 'decision' && k !== 'comment')).toEqual([]);
    expectErrors(await decide(inspector, c.id, { decision: 'REJECT', comment: 'x', labOrgId: UUID0 }), {
      labOrgId: ['validation.notAllowed'],
    });
    expectErrors(await decide(inspector, c.id, { decision: 'REJECT', comment: 'x', blockUpstream: true }), {
      blockUpstream: ['validation.notAllowed'],
    });
    expectErrors(await decide(inspector, c.id, { decision: 'LAB_TEST', comment: 'x' }), {
      labOrgId: ['validation.required'],
    });
    expectErrors(
      await decide(inspector, c.id, {
        decision: 'LAB_TEST',
        comment: 'x',
        labOrgId: UUID0,
        blockUpstream: false,
      }),
      {
        blockUpstream: ['validation.notAllowed'],
      },
    );
    expectErrors(await decide(inspector, c.id, { decision: 'RECALL', comment: '   ' }), {
      comment: ['validation.pattern'],
    });
    expectErrors(await decide(inspector, c.id, { decision: 'MAYBE', comment: 'x' }), {
      decision: ['validation.enum'],
    });
    expectProblem(await decide(inspector, UUID0, { decision: 'REJECT', comment: 'x' }), 404, 'NOT_FOUND');
    expectProblem(
      await decide(await loginAs('ADMIN'), c.id, { decision: 'REJECT', comment: 'x' }),
      403,
      'FORBIDDEN',
      null,
    );
  });

  it('REJECT (from IN_REVIEW): DECIDED with the comment, the deciding inspector and decidedAt; final → 409 {from: DECIDED, to: DECIDED}', async () => {
    const c = await newComplaint(batch);
    expect((await review(inspector, c.id)).status).toBe(200);
    // Any inspector decides, not only the reviewer: the deciding one becomes `inspector`.
    const other = await loginAs('INSPECTOR', { key: 'inspector' });
    const res = await decide(other, c.id, {
      decision: 'REJECT',
      comment: 'Претензия не связана с качеством',
    });
    expect(res.status, res.text).toBe(200);
    const otherId = (await other.get('/me')).body.id as string;
    expect(res.body).toMatchObject({
      status: 'DECIDED',
      decision: 'REJECT',
      decisionComment: 'Претензия не связана с качеством',
      inspector: { id: otherId },
      labTestId: null,
      recallId: null,
    });
    expect(res.body.decidedAt).not.toBeNull();
    expectProblem(
      await decide(inspector, c.id, { decision: 'REJECT', comment: 'x' }),
      409,
      'INVALID_TRANSITION',
      {
        from: 'DECIDED',
        to: 'DECIDED',
      },
    );
    expectProblem(await review(inspector, c.id), 409, 'INVALID_TRANSITION', {
      from: 'DECIDED',
      to: 'IN_REVIEW',
    });
  });

  it('LAB_TEST (from NEW): labOrgId not ACTIVE / not a laboratory → 400; an unplanned test (reason COMPLAINT) in that laboratory, LAB_ASSIGNED', async () => {
    const c = await newComplaint(batch);
    expectErrors(
      await decide(inspector, c.id, { decision: 'LAB_TEST', comment: 'Анализ', labOrgId: UUID0 }),
      {
        labOrgId: ['validation.notFound'],
      },
    );
    expectErrors(
      await decide(inspector, c.id, { decision: 'LAB_TEST', comment: 'Анализ', labOrgId: farm.orgId }),
      {
        labOrgId: ['validation.labOrg.type'],
      },
    );
    const lab = await vetlab();
    const since = await dbNow();
    const res = await decide(inspector, c.id, {
      decision: 'LAB_TEST',
      comment: 'Внеплановый анализ',
      labOrgId: lab.orgId,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'DECIDED', decision: 'LAB_TEST', recallId: null });
    const testId = res.body.labTestId as string;
    const t = await inspector.get(`/lab-tests/${testId}`);
    await expectContract(t, 'getLabTest');
    expect(t.body).toMatchObject({
      batch: { id: batch.id },
      lab: { id: lab.orgId },
      reason: 'COMPLAINT',
      status: 'QUEUED',
      version: 1,
    });
    const notes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.notificationType === 'LAB_ASSIGNED' && d.payload.labTestId === testId);
    expect(notes.length).toBe(1);
    expect(notes[0]!.payload).toMatchObject({ reason: 'COMPLAINT', labOrgId: lab.orgId, batchId: batch.id });
    expect(notes[0]!.recipients.orgIds).toEqual([lab.orgId, farm.orgId]);
  });

  it('RECALL: the engine with trigger COMPLAINT (reason = comment, complaintId); a second complaint on the batch reuses the OPEN recall', async () => {
    const b = await labApproved(farm);
    const c1 = await newComplaint(b);
    const since = await dbNow();
    const res = await decide(inspector, c1.id, {
      decision: 'RECALL',
      comment: 'Подтверждённые жалобы покупателей',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'DECIDED', decision: 'RECALL', labTestId: null });
    const recallId = res.body.recallId as string;
    const r = (await getRecall(inspector, recallId)).body;
    expect(r).toMatchObject({
      sourceBatch: { id: b.id, status: 'Recalled' },
      trigger: 'COMPLAINT',
      reason: 'Подтверждённые жалобы покупателей',
      blockUpstream: false,
      complaintId: c1.id,
      labTestId: null,
      openedBy: { id: inspectorId },
      status: 'OPEN',
    });
    const requested = (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since })).filter(
      (e) => e.payload.data.recallId === recallId,
    );
    expect(requested.map((e) => e.payload.data)).toEqual([
      { recallId, sourceBatchId: b.id, trigger: 'COMPLAINT', openedBy: inspectorId },
    ]);
    const c2 = await newComplaint(b);
    const since2 = await dbNow();
    const again = await decide(inspector, c2.id, {
      decision: 'RECALL',
      comment: 'Ещё одна',
      blockUpstream: true,
    });
    expect(again.status, again.text).toBe(200);
    expect(again.body.recallId).toBe(recallId);
    expect(
      (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since: since2 })).filter(
        (e) => e.payload.data.sourceBatchId === b.id,
      ),
    ).toEqual([]);
    expect((await getRecall(inspector, recallId)).body.complaintId).toBe(c1.id);
  });

  it('RECALL with blockUpstream: true on a derived batch recalls its sources too', async () => {
    const processor = await freshOrg('PROCESSOR');
    const a = await labApproved(farm);
    await deliver(farm.client, processor, a);
    const p = await processBatches(
      processor.client,
      [{ batchId: a.id, massUsedKg: a.massKg }],
      [{ productId: (await flour()).id, massKg: '500.000' }],
    );
    expect(p.status, p.text).toBe(201);
    const o = p.body.outputs[0] as BatchRef;
    const c = await newComplaint(o);
    const res = await decide(inspector, c.id, {
      decision: 'RECALL',
      comment: 'Отзыв с источниками',
      blockUpstream: true,
    });
    expect(res.status, res.text).toBe(200);
    const r = (await getRecall(inspector, res.body.recallId)).body as {
      blockUpstream: boolean;
      batches: { batch: { id: string }; direction: string }[];
    };
    expect(r.blockUpstream).toBe(true);
    expect(r.batches.map((x) => [x.batch.id, x.direction])).toEqual([
      [o.id, 'SOURCE'],
      [a.id, 'UP'],
    ]);
  });
});
