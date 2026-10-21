/**
 * Notifications (contracts/openapi/paths/notifications.yaml, contracts/rules/notifications.json,
 * contracts/events/notification.dispatch.schema.json, lab.escalate.schema.json; FR-NOTIF-01…04, R55/R56).
 *
 * The matrix: every notification type reaches IN_APP exactly the recipient groups of the rules file, with exactly
 * its payload keys; EMAIL rows are sent to Mailpit (DELIVERED, attempts 1); forced types ignore channel settings;
 * a re-published event is not handled twice (processed_events). markNotificationsRead by ids / upToSeq.
 *
 * Fixture writes (documented precedents): `recall_tasks.due_at` / `lab_tests.due_at` (time control, scheduler ticks
 * every second on the stand) and `outbox_events.published_at = NULL` (makes the relay publish an event a second time —
 * the at-least-once redelivery the consumer must absorb; no API re-publishes an event).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import rules from '../../contracts/rules/notifications.json' with { type: 'json' };
import { loginAs } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { fixtureWrite, outboxEvents, query } from './lib/db.js';
import { API_BACKEND } from './lib/env.js';
import { expectErrors } from './lib/expect.js';
import { waitForMails } from './lib/mail.js';
import { acceptWaybill, eventually, freshOrg, rejectWaybill, sentWaybill } from './lib/production.js';
import { solution } from './lib/altcha.js';
import {
  confirmTask,
  createRecall,
  freshFarm,
  inspector,
  inspectorTest,
  labApproved,
  listRecallTasks,
  rawBatch,
  submitAll,
  vetlab,
  type BatchRef,
  type FreshFarm,
} from './lib/quality.js';

type Type = keyof typeof rules.types;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Notification.payload is an open object
type Payload = Record<string, any>;
interface Item {
  id: string;
  seq: number;
  type: Type;
  payload: Payload;
  isRead: boolean;
  createdAt: string;
}

async function list(client: ApiClient, q: Record<string, string | number | boolean> = {}) {
  const res = await client.get('/notifications', { query: q });
  await expectContract(res, 'listNotifications');
  return res;
}

/** The newest IN_APP notification of `type` matching `pred` in the user's center, or undefined. */
async function find(client: ApiClient, type: Type, pred: (p: Payload) => boolean): Promise<Item | undefined> {
  const res = await list(client, { type, size: 100, sort: 'seq,desc' });
  expect(res.status, res.text).toBe(200);
  return (res.body.items as Item[]).find((n) => pred(n.payload));
}

/** Waits until the notification arrived; checks its payload keys against the rules file. */
async function arrives(client: ApiClient, type: Type, pred: (p: Payload) => boolean): Promise<Item> {
  const n = await eventually(() => find(client, type, pred));
  expect(Object.keys(n.payload).sort()).toEqual([...rules.types[type].payload].sort());
  expect(n.isRead).toBe(false);
  return n;
}

async function absent(client: ApiClient, type: Type, pred: (p: Payload) => boolean): Promise<void> {
  expect(await find(client, type, pred)).toBeUndefined();
}

async function me(client: ApiClient): Promise<{ id: string; email: string }> {
  const res = await client.get('/me');
  await expectContract(res, 'getMe');
  return { id: res.body.id, email: res.body.email };
}

describe('notification matrix (contracts/rules/notifications.json)', () => {
  let farm: FreshFarm;
  let processor: { client: ApiClient; orgId: string; userId: string };
  let insp: ApiClient;
  let labHead: ApiClient;
  let labAnalyst: ApiClient;
  let b: BatchRef;
  let testId: string;

  beforeAll(async () => {
    farm = await freshFarm();
    processor = await freshOrg('PROCESSOR');
    insp = await inspector();
    labHead = (await vetlab()).client;
    labAnalyst = await loginAs('LAB', { key: 'vetlab.analyst' });
    b = await rawBatch(farm);
  });

  it('LAB_ASSIGNED → labOrg (every user) + batchOrigin; LAB_RESULT → batchOrigin + inspectors (unplanned test)', async () => {
    const t = await inspectorTest(b.id);
    testId = t.id;
    const lab = await vetlab();
    const assigned = (p: Payload) => p.labTestId === t.id;
    const n = await arrives(farm.client, 'LAB_ASSIGNED', assigned);
    expect(n.payload).toMatchObject({
      batchId: b.id,
      publicCode: b.publicCode,
      labOrgId: lab.orgId,
      reason: 'INSPECTOR',
    });
    await arrives(labHead, 'LAB_ASSIGNED', assigned);
    await arrives(labAnalyst, 'LAB_ASSIGNED', assigned);
    await absent(processor.client, 'LAB_ASSIGNED', assigned);
    await absent(insp, 'LAB_ASSIGNED', assigned);

    await submitAll(t, '0');
    const result = (p: Payload) => p.labTestId === t.id;
    const r = await arrives(farm.client, 'LAB_RESULT', result);
    expect(r.payload).toMatchObject({ conclusion: 'PASS', recallId: null, publicCode: b.publicCode });
    await arrives(insp, 'LAB_RESULT', result);
    await absent(labHead, 'LAB_RESULT', result);
  });

  it('WAYBILL_INCOMING → waybillReceiver only', async () => {
    const wb = await sentWaybill(farm.client, processor.orgId, [b]);
    const n = await arrives(processor.client, 'WAYBILL_INCOMING', (p) => p.waybillId === wb.id);
    expect(n.payload).toMatchObject({ number: wb.number, senderOrgId: farm.orgId, itemsCount: 1 });
    await absent(farm.client, 'WAYBILL_INCOMING', (p) => p.waybillId === wb.id);
    const acc = await acceptWaybill(processor.client, wb, [{ batchId: b.id, massActualKg: b.massKg }]);
    expect(acc.status, acc.text).toBe(200);
  });

  it('RECALL OPENED → inspectors + taskHolders + sourceOrigin; RECALL_TASK CREATED → taskHolder; OVERDUE → taskHolder + inspectors; RECALL CLOSED → inspectors only', async () => {
    const res = await createRecall(insp, {
      sourceBatchId: b.id,
      reason: 'Матрица уведомлений',
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const recallId = res.body.id as string;
    const opened = (p: Payload) => p.recallId === recallId && p.event === 'OPENED';
    const o = await arrives(farm.client, 'RECALL', opened);
    expect(o.payload).toMatchObject({ sourceBatchId: b.id, publicCode: b.publicCode, trigger: 'INSPECTOR' });
    await arrives(processor.client, 'RECALL', opened);
    await arrives(insp, 'RECALL', opened);
    await absent(labHead, 'RECALL', opened);

    const created = await arrives(
      processor.client,
      'RECALL_TASK',
      (p) => p.recallId === recallId && p.event === 'CREATED',
    );
    expect(created.payload.batchId).toBe(b.id);
    await absent(farm.client, 'RECALL_TASK', (p) => p.recallId === recallId);
    const taskId = created.payload.taskId as string;

    // Time control (documented precedent, Tasks 9/10): the task's deadline passes; the scheduler ticks every second.
    await fixtureWrite(`UPDATE recall_tasks SET due_at = now() - interval '1 second' WHERE id = $1`, [
      taskId,
    ]);
    const overdue = (p: Payload) => p.taskId === taskId;
    const od = await arrives(processor.client, 'OVERDUE', overdue);
    expect(od.payload).toMatchObject({ recallId, batchId: b.id, holderOrgId: processor.orgId });
    await arrives(insp, 'OVERDUE', overdue);
    await absent(farm.client, 'OVERDUE', overdue);

    const tasks = await listRecallTasks(processor.client, { recallId });
    const task = (tasks.body.items as { id: string; version: number }[]).find((x) => x.id === taskId)!;
    const conf = await confirmTask(processor.client, taskId, task.version);
    expect(conf.status, conf.text).toBe(200);
    const closed = (p: Payload) => p.recallId === recallId && p.event === 'CLOSED';
    await arrives(insp, 'RECALL', closed);
    await absent(farm.client, 'RECALL', closed);
    await absent(processor.client, 'RECALL', closed);
  });

  it('RECALL_TASK REASSIGNED (rejectWaybill) → the new taskHolder', async () => {
    const b3 = await labApproved(farm);
    const wb = await sentWaybill(farm.client, processor.orgId, [b3]);
    const res = await createRecall(insp, {
      sourceBatchId: b3.id,
      reason: 'Переназначение',
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const recallId = res.body.id as string;
    await arrives(processor.client, 'RECALL_TASK', (p) => p.recallId === recallId && p.event === 'CREATED');
    const rej = await rejectWaybill(processor.client, wb, 'Партия отозвана');
    expect(rej.status, rej.text).toBe(200);
    const n = await arrives(
      farm.client,
      'RECALL_TASK',
      (p) => p.recallId === recallId && p.event === 'REASSIGNED',
    );
    expect(n.payload.batchId).toBe(b3.id);
  });

  it('COMPLAINT → inspectors', async () => {
    const b2 = await rawBatch(farm);
    const buyer = api();
    const res = await buyer.post(`/public/batches/${b2.publicCode}/complaints`, {
      text: 'Посторонний запах у продукта',
      altcha: await solution(buyer),
    });
    await expectContract(res, 'createPublicComplaint');
    expect(res.status, res.text).toBe(201);
    const n = await arrives(insp, 'COMPLAINT', (p) => p.complaintId === res.body.id);
    expect(n.payload).toMatchObject({ batchId: b2.id, publicCode: b2.publicCode });
    await absent(farm.client, 'COMPLAINT', (p) => p.complaintId === res.body.id);
  });

  it('LAB_OVERDUE (lab.escalate) → labOrgHeads + inspectors, not the other lab users', async () => {
    const b4 = await rawBatch(farm);
    const t = await inspectorTest(b4.id);
    // Time control (documented precedent, Task 9): the test's deadline passes; the scheduler escalates it.
    await fixtureWrite(`UPDATE lab_tests SET due_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    const mine = (p: Payload) => p.labTestId === t.id;
    const n = await arrives(labHead, 'LAB_OVERDUE', mine);
    expect(n.payload).toMatchObject({
      batchId: b4.id,
      publicCode: b4.publicCode,
      labOrgId: (await vetlab()).orgId,
    });
    expect(typeof n.payload.labName).toBe('string');
    await arrives(insp, 'LAB_OVERDUE', mine);
    await absent(labAnalyst, 'LAB_OVERDUE', mine);
    await absent(farm.client, 'LAB_OVERDUE', mine);
  });

  it('EMAIL: rows are sent to Mailpit (DELIVERED, attempts 1); a re-published event creates nothing twice', async () => {
    const head = await me(farm.client);
    // LAB_ASSIGNED (channels.email defaults to true) and RECALL (forced) of the scenario above, by email.
    const mails = await waitForMails(head.email, 3, 20000);
    expect(mails.some((m) => m.subject.includes(b.publicCode))).toBe(true);
    const rows = await eventually(async () => {
      const r = await query<{ delivery_status: string; attempts: number }>(
        `SELECT delivery_status, attempts FROM notifications
          WHERE user_id = $1 AND channel = 'EMAIL' AND payload->>'labTestId' = $2`,
        [head.id, testId],
      );
      return r.length > 0 && r.every((x) => x.delivery_status !== 'PENDING') ? r : undefined;
    });
    expect(rows).toEqual([
      { delivery_status: 'DELIVERED', attempts: 1 },
      { delivery_status: 'DELIVERED', attempts: 1 },
    ]);

    // Redelivery (R56): the LAB_ASSIGNED dispatch of the inspector test is published once more.
    const [ev] = (await outboxEvents({ backend: API_BACKEND, type: 'notification.dispatch' })).filter(
      (e) =>
        e.payload.data.notificationType === 'LAB_ASSIGNED' && e.payload.data.payload.labTestId === testId,
    );
    expect(ev, 'LAB_ASSIGNED dispatch row').toBeDefined();
    const count = async () =>
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*) AS n FROM notifications WHERE type = 'LAB_ASSIGNED' AND payload->>'labTestId' = $1`,
            [testId],
          )
        )[0]!.n,
      );
    const before = await count();
    await fixtureWrite(`UPDATE outbox_events SET published_at = NULL WHERE id = $1`, [ev!.id]);
    await eventually(async () => {
      const r = await query<{ published_at: Date | null }>(
        `SELECT published_at FROM outbox_events WHERE id = $1`,
        [ev!.id],
      );
      return r[0]?.published_at ? true : undefined;
    });
    await new Promise((r) => setTimeout(r, 2000));
    expect(await count()).toBe(before);
    const claims = await query(`SELECT 1 FROM processed_events WHERE event_id = $1`, [ev!.id]);
    expect(claims).toHaveLength(1);
  });
});

describe('channel settings (FR-NOTIF-03)', () => {
  it('email off: no EMAIL row for LAB_ASSIGNED; forced RECALL / RECALL_TASK still go by email', async () => {
    const farm = await freshFarm();
    const user = await me(farm.client);
    const put = await farm.client.put('/me/channels', { email: false, telegram: false });
    await expectContract(put, 'updateMyChannels');
    expect(put.status, put.text).toBe(200);
    const b = await rawBatch(farm);
    expect(b.status).toBe('OnTest');
    await arrives(farm.client, 'LAB_ASSIGNED', (p) => p.batchId === b.id);
    const insp = await inspector();
    const res = await createRecall(insp, { sourceBatchId: b.id, reason: 'Каналы', blockUpstream: false });
    expect(res.status, res.text).toBe(201);
    await arrives(farm.client, 'RECALL_TASK', (p) => p.recallId === res.body.id);
    const rows = await eventually(async () => {
      const r = await query<{ type: string; delivery_status: string }>(
        `SELECT type, delivery_status FROM notifications WHERE user_id = $1 AND channel = 'EMAIL' ORDER BY type`,
        [user.id],
      );
      return r.length === 2 && r.every((x) => x.delivery_status === 'DELIVERED') ? r : undefined;
    });
    expect(rows.map((r) => r.type)).toEqual(['RECALL', 'RECALL_TASK']);
    const mails = await waitForMails(user.email, 2);
    expect(mails.every((m) => m.subject.includes(b.publicCode))).toBe(true);
  });
});

describe('listNotifications', () => {
  it('own IN_APP rows only; filters isRead / type / from-to; seq sort; parameter errors', async () => {
    const farm = await freshFarm();
    const empty = await list(farm.client);
    expect(empty.status, empty.text).toBe(200);
    expect(empty.body).toEqual({ items: [], page: 1, size: 20, total: 0 });
    await rawBatch(farm); // LAB_ASSIGNED (NEW_FARM sample)
    await rawBatch(farm);
    const all = await eventually(async () => {
      const r = await list(farm.client);
      return r.body.total === 2 ? r : undefined;
    });
    const seqs = (all.body.items as Item[]).map((n) => n.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
    const asc = await list(farm.client, { sort: 'seq,asc' });
    expect((asc.body.items as Item[]).map((n) => n.seq)).toEqual([...seqs].reverse());
    expect((await list(farm.client, { isRead: true })).body.total).toBe(0);
    expect((await list(farm.client, { isRead: false })).body.total).toBe(2);
    expect((await list(farm.client, { type: 'RECALL' })).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await list(farm.client, { from: today, to: today })).body.total).toBe(2);
    expect((await list(farm.client, { to: '2020-01-01' })).body.total).toBe(0);
    // EMAIL rows exist for the same notifications but are never listed.
    const user = await me(farm.client);
    const external = await query(`SELECT 1 FROM notifications WHERE user_id = $1 AND channel <> 'IN_APP'`, [
      user.id,
    ]);
    expect(external.length).toBeGreaterThan(0);

    expectErrors(await list(farm.client, { sort: 'createdAt,desc' }), { sort: ['validation.sort'] });
    expectErrors(await list(farm.client, { type: 'NOPE' }), { type: ['validation.enum'] });
    expectErrors(await list(farm.client, { isRead: 'yes' }), { isRead: ['validation.type'] });
    expectErrors(await list(farm.client, { from: '2026-09-02', to: '2026-09-01' }), {
      from: ['validation.range'],
    });
    const anon = await list(api());
    expect(anon.status).toBe(401);
  });
});

describe('markNotificationsRead', () => {
  it('ids (own IN_APP only, else ids[i] notFound and nothing marked), upToSeq, idempotent; the unread count', async () => {
    const farm = await freshFarm();
    await rawBatch(farm);
    await rawBatch(farm);
    const items = await eventually(async () => {
      const r = await list(farm.client, { sort: 'seq,asc' });
      return r.body.total === 2 ? (r.body.items as Item[]) : undefined;
    });
    const mark = async (client: ApiClient, body: unknown) => {
      const res = await client.post('/notifications/read', body);
      await expectContract(res, 'markNotificationsRead');
      return res;
    };
    const user = await me(farm.client);
    const emailRow = (
      await query<{ id: string }>(
        `SELECT id FROM notifications WHERE user_id = $1 AND channel = 'EMAIL' LIMIT 1`,
        [user.id],
      )
    )[0]!;
    const other = await freshFarm();
    await rawBatch(other);
    const foreign = await eventually(async () => {
      const r = await list(other.client);
      return r.body.total === 1 ? (r.body.items as Item[])[0] : undefined;
    });

    expectErrors(await mark(farm.client, { ids: [items[0]!.id, foreign.id, emailRow.id] }), {
      'ids[1]': ['validation.notFound'],
      'ids[2]': ['validation.notFound'],
    });
    expect((await list(farm.client, { isRead: false })).body.total).toBe(2);

    const one = await mark(farm.client, { ids: [items[0]!.id.toUpperCase()] });
    expect(one.status, one.text).toBe(200);
    expect(one.body).toEqual({ count: 1 });
    expect((await mark(farm.client, { ids: [items[0]!.id] })).body).toEqual({ count: 1 });
    const read = await list(farm.client, { isRead: true });
    expect((read.body.items as Item[]).map((n) => n.id)).toEqual([items[0]!.id]);

    const upTo = await mark(farm.client, { upToSeq: items[1]!.seq });
    expect(upTo.body).toEqual({ count: 0 });
    expect((await list(other.client, { isRead: false })).body.total).toBe(1);

    expectErrors(await mark(farm.client, { ids: [] }), { ids: ['validation.minItems'] });
    const bad = await mark(farm.client, {});
    expect(bad.status, bad.text).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');
    expect((await mark(api(), { upToSeq: 1 })).status).toBe(401);
  });
});
