/**
 * Recalls and recall tasks (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml; tag Recalls steps 1–7, БП-5,
 * BR-08, BR-09, BR-10, R50, R52, R54, R89): createRecall (DOWN, UP with blockUpstream, statuses by п. 5.1, soft-deleted
 * batches walked through, tasks to holders and to the receiver of an InTransit batch, dueAt = openedAt + 24 h, the
 * vacuous close, reuse of the OPEN recall of the source), the card, the register, the graph, the tasks and their
 * confirmation (WrittenOff, the last one closes the recall), the `recall-task-overdue` scheduler, the consumers of
 * `recall.requested` (RECALL OPENED, RECALL_TASK CREATED) and `rating.recalculate` (BR-09, eventually consistent:
 * the tests poll getOrganization with a deadline), and the race acceptWaybill vs createRecall (Review Focus 1).
 *
 * Recall sources of raw batches belong to fresh farms (lib/quality.ts): a recall lowers the source farm's rating.
 * Time control as in lab.test.ts: a task is made overdue by a documented fixture write of `recall_tasks.due_at`, the
 * test stand ticks the scheduler every second (SCHEDULER_TICK_MS); the DB clock decides "now > due".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { auditEntries } from './lib/audit.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, dbNow, fixtureWrite, outboxEvents, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import {
  acceptWaybill,
  deliver,
  eventually,
  flour,
  freshOrg,
  getBatch,
  processBatches,
  sentWaybill,
} from './lib/production.js';
import {
  confirmTask,
  createRecall,
  freshFarm,
  getRecall,
  inspector as inspectorOf,
  inspectorTest,
  labApproved,
  listRecallTasks,
  listRecalls,
  rand,
  rawBatch,
  submitAll,
  trustRating,
  type BatchRef,
  type FreshFarm,
} from './lib/quality.js';
import { closeRedis, redis } from './lib/redis.js';
import { instant, instants } from './lib/time.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const BACKEND = process.env.API_BACKEND ?? 'express';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;

interface Org {
  client: ApiClient;
  orgId: string;
  userId: string;
}

interface RecallTask {
  id: string;
  recallId: string;
  recallReason: string;
  batch: { id: string; publicCode: string; status: string };
  holder: { id: string };
  dueAt: string;
  status: string;
  overdue: boolean;
  escalatedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: { id: string; fullName: string; avatarUrl: string | null } | null;
  createdAt: string;
  version: number;
}
interface Recall {
  id: string;
  sourceBatch: { id: string; publicCode: string };
  trigger: string;
  reason: string;
  status: string;
  blockUpstream: boolean;
  openedAt: string;
  closedAt: string | null;
  progress: { confirmed: number; total: number; overdue: number };
  batchesCount: number;
  openedBy: { id: string; fullName: string } | null;
  labTestId: string | null;
  complaintId: string | null;
  batches: {
    batch: { id: string; publicCode: string; status: string };
    direction: string;
    depth: number;
    statusBefore: string;
  }[];
  tasks: RecallTask[];
  version: number;
}

const byCode = <T extends { publicCode: string }>(a: T, b: T) =>
  a.publicCode < b.publicCode ? -1 : a.publicCode > b.publicCode ? 1 : 0;

let inspector: ApiClient;
let inspectorId: string;
beforeAll(async () => {
  inspector = await inspectorOf();
  inspectorId = (await inspector.get('/me')).body.id as string;
});

/**
 * A (fresh farm, Approved) → processor (Accepted) → O1, O2 (flour); O1 shipped to the retailer (InTransit); O2 → O3
 * (Approved at the processor). O2 is Processed.
 */
async function chain() {
  const farm = await freshFarm();
  const processor: Org = await freshOrg('PROCESSOR');
  const retailer: Org = await freshOrg('RETAILER');
  const flourId = (await flour()).id;
  const a0 = await labApproved(farm);
  await deliver(farm.client, processor, a0);
  const p1 = await processBatches(
    processor.client,
    [{ batchId: a0.id, massUsedKg: a0.massKg }],
    [
      { productId: flourId, massKg: '400.000' },
      { productId: flourId, massKg: '400.000' },
    ],
  );
  expect(p1.status, p1.text).toBe(201);
  const [o1, o2] = p1.body.outputs as BatchRef[];
  await sentWaybill(processor.client, retailer.orgId, [o1!]);
  const p2 = await processBatches(
    processor.client,
    [{ batchId: o2!.id, massUsedKg: o2!.massKg }],
    [{ productId: flourId, massKg: '300.000' }],
  );
  expect(p2.status, p2.text).toBe(201);
  const o3 = p2.body.outputs[0] as BatchRef;
  const a = (await getBatch(processor.client, a0.id)).body as BatchRef;
  return { farm, processor, retailer, a, o1: o1!, o2: o2!, o3 };
}

/** The ACTIVE, non-deleted users of `orgIds` plus every ACTIVE inspector (contract notification.dispatch). */
async function recipients(orgIds: string[], inspectors: boolean): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL
        AND (u.organization_id = ANY($1::uuid[])
             OR ($2 AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                 WHERE ur.user_id = u.id AND r.code = 'INSPECTOR')))`,
    [orgIds, inspectors],
  );
  return rows.map((r) => r.id).sort();
}

async function notifications(recallId: string, type: string, event: string) {
  return query<{ user_id: string; channel: string; payload: Record<string, unknown> }>(
    `SELECT user_id, channel, payload FROM notifications
      WHERE type = $1 AND payload->>'recallId' = $2 AND payload->>'event' = $3`,
    [type, recallId, event],
  );
}

/** Waits until the worker handled the recall's `recall.requested` (its `processed_events` claim exists). */
async function handled(recallId: string): Promise<void> {
  const [ev] = (await outboxEvents({ backend: BACKEND, type: 'recall.requested' })).filter(
    (e) => e.payload.data.recallId === recallId,
  );
  expect(ev, 'recall.requested of the recall').toBeDefined();
  await eventually(async () => {
    const r = await query(`SELECT 1 FROM processed_events WHERE event_id = $1`, [ev!.id]);
    return r.length > 0 ? true : undefined;
  });
}

const reason = () => `Ручной отзыв ${rand()}: подозрение на нарушение`;

describe('createRecall', () => {
  it('x-roles INSPECTOR; body by schema; an unknown or deleted source → 400 sourceBatchId notFound', async () => {
    const body = { sourceBatchId: UUID0, reason: 'Причина', blockUpstream: false };
    expectProblem(await createRecall(api(), body), 401, 'UNAUTHORIZED');
    for (const role of ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'ADMIN'] as Role[])
      expectProblem(await createRecall(await loginAs(role), body), 403, 'FORBIDDEN', null);
    expectErrors(await createRecall(inspector, {}), {
      sourceBatchId: ['validation.required'],
      reason: ['validation.required'],
      blockUpstream: ['validation.required'],
    });
    expectErrors(
      await createRecall(inspector, {
        sourceBatchId: 'nope',
        reason: '   ',
        blockUpstream: 'yes',
        extra: 1,
      }),
      {
        sourceBatchId: ['validation.uuid'],
        reason: ['validation.pattern'],
        blockUpstream: ['validation.type'],
        extra: ['validation.unknownField'],
      },
    );
    expectErrors(await createRecall(inspector, { ...body, reason: 'я'.repeat(1001) }), {
      reason: ['validation.maxLength'],
    });
    expectErrors(await createRecall(inspector, body), { sourceBatchId: ['validation.notFound'] });
  });

  it('DOWN: statuses by п. 5.1, tasks to the holders and to the receiver of the InTransit batch, dueAt = openedAt + 24 h; an OPEN recall of the source → 200 unchanged; recall.requested → RECALL OPENED and RECALL_TASK CREATED', async () => {
    const { farm, processor, retailer, a, o1, o2, o3 } = await chain();
    await redis().set(`pub:batch:${o1.publicCode}`, '{"stale":true}', 'EX', 300);
    const since = await dbNow();
    const why = reason();
    const res = await createRecall(inspector, { sourceBatchId: a.id, reason: why, blockUpstream: false });
    expect(res.status, res.text).toBe(201);
    const r = res.body as Recall;
    expect(r).toMatchObject({
      sourceBatch: { id: a.id, publicCode: a.publicCode, status: 'Processed' },
      trigger: 'INSPECTOR',
      reason: why,
      status: 'OPEN',
      blockUpstream: false,
      closedAt: null,
      progress: { confirmed: 0, total: 2, overdue: 0 },
      batchesCount: 4,
      openedBy: { id: inspectorId },
      labTestId: null,
      complaintId: null,
      version: 1,
    });
    // SOURCE, DOWN, UP — then depth, then publicCode.
    expect(r.batches.map((x) => [x.batch.id, x.direction, x.depth, x.statusBefore, x.batch.status])).toEqual([
      [a.id, 'SOURCE', 0, 'Processed', 'Processed'],
      ...[
        [o1, 'InTransit', 'Recalled'],
        [o2, 'Processed', 'Processed'],
      ]
        .sort((x, y) => byCode(x[0] as BatchRef, y[0] as BatchRef))
        .map(([b, before, now]) => [(b as BatchRef).id, 'DOWN', 1, before, now]),
      [o3.id, 'DOWN', 2, 'Approved', 'Recalled'],
    ]);
    // Tasks by dueAt (equal), then publicCode: InTransit → the receiver of the SENT waybill.
    const expectedTasks = [
      { b: o1, holder: retailer.orgId },
      { b: o3, holder: processor.orgId },
    ].sort((x, y) => byCode(x.b, y.b));
    expect(r.tasks.map((t) => [t.batch.id, t.holder.id])).toEqual(
      expectedTasks.map((t) => [t.b.id, t.holder]),
    );
    for (const t of r.tasks) {
      expect(t).toMatchObject({
        recallId: r.id,
        recallReason: why,
        status: 'OPEN',
        overdue: false,
        escalatedAt: null,
        confirmedAt: null,
        confirmedBy: null,
        version: 1,
        batch: { status: 'Recalled' },
      });
      expect(instant(t.dueAt)).toBe(instant(r.openedAt) + DAY);
      expect(instant(t.createdAt)).toBe(instant(r.openedAt));
    }
    expect((await getBatch(inspector, o1.id)).body.status).toBe('Recalled');
    expect((await getBatch(inspector, o3.id)).body).toMatchObject({
      status: 'Recalled',
      version: o3.version + 1,
    });
    const h = (await inspector.get(`/batches/${o3.id}/history`)).body as { to: string; reason: string }[];
    expect(h.at(-1)).toMatchObject({ to: 'Recalled', reason: 'RECALLED' });
    expect(await redis().exists(`pub:batch:${o1.publicCode}`)).toBe(0);
    expect(instants((await getRecall(inspector, r.id)).body)).toEqual(instants(r));

    const requested = (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since })).filter(
      (e) => e.payload.data.recallId === r.id,
    );
    expect(requested.map((e) => e.payload.data)).toEqual([
      { recallId: r.id, sourceBatchId: a.id, trigger: 'INSPECTOR', openedBy: inspectorId },
    ]);
    const audit = await auditEntries({ entityType: 'recall', entityId: r.id });
    expect(audit.map((e) => [e.action, e.diff.status])).toEqual([['createRecall', [null, 'OPEN']]]);

    // Step 1: the OPEN recall of the source is returned as is (its reason; blockUpstream of the request ignored).
    const since2 = await dbNow();
    const again = await createRecall(inspector, {
      sourceBatchId: a.id,
      reason: 'Другая',
      blockUpstream: true,
    });
    expect(again.status, again.text).toBe(200);
    expect(instants(again.body)).toEqual(instants(r));
    expect(
      (await outboxEvents({ backend: BACKEND, type: 'recall.requested', since: since2 })).filter(
        (e) => e.payload.data.sourceBatchId === a.id,
      ),
    ).toEqual([]);

    // The recall.requested handler (asynchronous): RECALL OPENED to the inspectors, every task holder and the source
    // origin; RECALL_TASK CREATED to each task's holder — one IN_APP row per user, EMAIL too (forced channels).
    await handled(r.id);
    const opened = await notifications(r.id, 'RECALL', 'OPENED');
    const inApp = opened.filter((n) => n.channel === 'IN_APP');
    expect(inApp.map((n) => n.user_id).sort()).toEqual(
      await recipients([retailer.orgId, processor.orgId, farm.orgId], true),
    );
    expect(opened.filter((n) => n.channel === 'EMAIL').length).toBe(inApp.length);
    for (const n of inApp)
      expect(n.payload).toEqual({
        recallId: r.id,
        event: 'OPENED',
        sourceBatchId: a.id,
        publicCode: a.publicCode,
        trigger: 'INSPECTOR',
      });
    const created = (await notifications(r.id, 'RECALL_TASK', 'CREATED')).filter(
      (n) => n.channel === 'IN_APP',
    );
    for (const t of r.tasks) {
      const rows = created.filter((n) => n.payload.taskId === t.id);
      expect(rows.map((n) => n.user_id).sort()).toEqual(await recipients([t.holder.id], false));
      for (const n of rows)
        expect(instants(n.payload)).toEqual(
          instants({
            recallId: r.id,
            taskId: t.id,
            batchId: t.batch.id,
            publicCode: t.batch.publicCode,
            dueAt: t.dueAt,
            event: 'CREATED',
          }),
        );
    }
    expect(created.length).toBe(
      (await recipients([retailer.orgId], false)).length +
        (await recipients([processor.orgId], false)).length,
    );
  });

  it('UP with blockUpstream: the ancestors at their depth, without their other descendants; Processed ancestors keep their status and get no task', async () => {
    const { processor, a, o1, o2, o3 } = await chain();
    const res = await createRecall(inspector, {
      sourceBatchId: o3.id,
      reason: reason(),
      blockUpstream: true,
    });
    expect(res.status, res.text).toBe(201);
    const r = res.body as Recall;
    expect(r.blockUpstream).toBe(true);
    expect(r.batches.map((x) => [x.batch.id, x.direction, x.depth, x.statusBefore, x.batch.status])).toEqual([
      [o3.id, 'SOURCE', 0, 'Approved', 'Recalled'],
      [o2.id, 'UP', 1, 'Processed', 'Processed'],
      [a.id, 'UP', 2, 'Processed', 'Processed'],
    ]);
    expect(r.batches.some((x) => x.batch.id === o1.id)).toBe(false);
    expect(r.tasks.map((t) => [t.batch.id, t.holder.id])).toEqual([[o3.id, processor.orgId]]);
    expect((await getBatch(inspector, o1.id)).body.status).toBe('InTransit');
  });

  it('soft-deleted batches (R59): the walk passes through them, they are not recorded; a deleted source → 400 notFound', async () => {
    const farm = await freshFarm();
    const processor: Org = await freshOrg('PROCESSOR');
    const flourId = (await flour()).id;
    const a = await labApproved(farm);
    await deliver(farm.client, processor, a);
    const p1 = await processBatches(
      processor.client,
      [{ batchId: a.id, massUsedKg: a.massKg }],
      [{ productId: flourId, massKg: '500.000' }],
    );
    expect(p1.status, p1.text).toBe(201);
    const b = p1.body.outputs[0] as BatchRef;
    const p2 = await processBatches(
      processor.client,
      [{ batchId: b.id, massUsedKg: b.massKg }],
      [{ productId: flourId, massKg: '400.000' }],
    );
    expect(p2.status, p2.text).toBe(201);
    const c = p2.body.outputs[0] as BatchRef;
    // No API operation deletes a batch (the soft delete is R59 data state): a documented fixture write.
    await fixtureWrite(`UPDATE batches SET deleted_at = now() WHERE id = $1`, [b.id]);
    expectErrors(
      await createRecall(inspector, { sourceBatchId: b.id, reason: reason(), blockUpstream: false }),
      {
        sourceBatchId: ['validation.notFound'],
      },
    );
    const res = await createRecall(inspector, {
      sourceBatchId: a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const r = res.body as Recall;
    expect(r.batches.map((x) => [x.batch.id, x.direction, x.depth])).toEqual([
      [a.id, 'SOURCE', 0],
      [c.id, 'DOWN', 2],
    ]);
    expect(r.batchesCount).toBe(2);
    expect(r.tasks.map((t) => t.batch.id)).toEqual([c.id]);
  });

  it('no task → CLOSED at once (BR-10): closedAt = openedAt, version 2, RECALL CLOSED in its transaction, no OPENED from the handler (R89); the rating counts the recall', async () => {
    const farm = await freshFarm();
    const retailer: Org = await freshOrg('RETAILER');
    const a = await labApproved(farm); // LAB_PASS: 80 → 82
    await deliver(farm.client, retailer, a);
    let card = (await getBatch(retailer.client, a.id)).body;
    const os = await retailer.client.post(`/batches/${a.id}/on-sale`, undefined, {
      headers: { 'If-Match': String(card.version) },
    });
    expect(os.status, os.text).toBe(200);
    const sold = await retailer.client.post(`/batches/${a.id}/sold`, undefined, {
      headers: { 'If-Match': String(os.body.version) },
    });
    expect(sold.status, sold.text).toBe(200);
    card = sold.body;
    expect(card.status).toBe('Sold');
    const since = await dbNow();
    const res = await createRecall(inspector, {
      sourceBatchId: a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const r = res.body as Recall;
    expect(r).toMatchObject({
      status: 'CLOSED',
      version: 2,
      tasks: [],
      progress: { confirmed: 0, total: 0, overdue: 0 },
      batchesCount: 1,
    });
    expect(instant(r.closedAt!)).toBe(instant(r.openedAt));
    expect(r.batches.map((x) => [x.direction, x.statusBefore, x.batch.status])).toEqual([
      ['SOURCE', 'Sold', 'Sold'],
    ]);
    const closeNotes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.notificationType === 'RECALL' && d.payload.recallId === r.id);
    expect(closeNotes).toEqual([
      {
        notificationType: 'RECALL',
        recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          recallId: r.id,
          event: 'CLOSED',
          sourceBatchId: a.id,
          publicCode: a.publicCode,
          trigger: 'INSPECTOR',
        },
      },
    ]);
    await handled(r.id);
    expect(await notifications(r.id, 'RECALL', 'OPENED')).toEqual([]);
    // rating.recalculate from the handler: 82 − 10 (RECALL_SOURCE).
    await eventually(async () => ((await trustRating(farm.orgId)) === 72 ? true : undefined));
  });
});

describe('getRecall, listRecalls, getRecallGraph', () => {
  let open: Recall;
  let closed: Recall;
  let parts: Awaited<ReturnType<typeof chain>>;
  beforeAll(async () => {
    parts = await chain();
    const o = await createRecall(inspector, {
      sourceBatchId: parts.a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(o.status, o.text).toBe(201);
    open = o.body;
    // A recall whose source is already Recalled (by `open`) and has no descendants: no task → CLOSED at once.
    const c = await createRecall(inspector, {
      sourceBatchId: parts.o3.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(c.status, c.text).toBe(201);
    closed = c.body;
    expect(closed.status).toBe('CLOSED');
  });

  it('x-roles INSPECTOR and ADMIN; unknown → 404; id by uuid', async () => {
    const admin = await loginAs('ADMIN');
    expect((await getRecall(admin, open.id)).status).toBe(200);
    expect((await listRecalls(admin)).status).toBe(200);
    for (const role of ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER'] as Role[]) {
      const c = await loginAs(role);
      expectProblem(await getRecall(c, open.id), 403, 'FORBIDDEN', null);
      expectProblem(await listRecalls(c), 403, 'FORBIDDEN', null);
      const g = await c.get(`/recalls/${open.id}/graph`);
      await expectContract(g, 'getRecallGraph');
      expectProblem(g, 403, 'FORBIDDEN', null);
    }
    expectProblem(await getRecall(inspector, UUID0), 404, 'NOT_FOUND');
    const g404 = await inspector.get(`/recalls/${UUID0}/graph`);
    await expectContract(g404, 'getRecallGraph');
    expectProblem(g404, 404, 'NOT_FOUND');
    expectErrors(await getRecall(inspector, 'x'), { id: ['validation.uuid'] });
  });

  it('listRecalls: status, trigger (repeated), batchId (any member), q, from/to by the UTC date of openedAt, x-sort', async () => {
    const ids = async (q: string) => {
      const res = await inspector.get(`/recalls?size=100&${q}`);
      await expectContract(res, 'listRecalls');
      expect(res.status, res.text).toBe(200);
      return (res.body.items as Recall[]).map((x) => x.id);
    };
    const mine = [open.id, closed.id];
    // The result order restricted to this test's recalls (other suites add recalls of their own).
    const pick = (xs: string[]) => xs.filter((id) => mine.includes(id));
    // Default openedAt,desc: the later (closed) one first.
    expect(pick(await ids(`batchId=${parts.o3.id}`))).toEqual([closed.id, open.id]);
    expect(pick(await ids(`batchId=${parts.o2.id}`))).toEqual([open.id]);
    expect(pick(await ids(`batchId=${parts.o2.id}&status=OPEN`))).toEqual([open.id]);
    expect(pick(await ids(`batchId=${parts.o3.id}&status=CLOSED`))).toEqual([closed.id]);
    expect(pick(await ids(`batchId=${parts.o3.id}&trigger=LAB&trigger=COMPLAINT`))).toEqual([]);
    expect(pick(await ids(`batchId=${parts.o3.id}&trigger=LAB&trigger=INSPECTOR`))).toEqual([
      closed.id,
      open.id,
    ]);
    expect(pick(await ids(`q=${parts.a.publicCode.toLowerCase()}`))).toEqual([open.id]);
    const today = open.openedAt.slice(0, 10);
    const tomorrow = new Date(instant(closed.openedAt) + DAY).toISOString().slice(0, 10);
    const closedDay = closed.openedAt.slice(0, 10);
    expect(pick(await ids(`batchId=${parts.o3.id}&from=${today}&to=${closedDay}`))).toEqual([
      closed.id,
      open.id,
    ]);
    expect(pick(await ids(`batchId=${parts.o3.id}&from=${tomorrow}`))).toEqual([]);
    // closedAt,desc: nulls last.
    const byClosed = await ids(`batchId=${parts.o3.id}&sort=closedAt,desc`);
    expect(pick(byClosed)).toEqual([closed.id, open.id]);
    const byOpened = await ids(`batchId=${parts.o3.id}&sort=openedAt,asc`);
    expect(pick(byOpened)).toEqual([open.id, closed.id]);
    const item = (await listRecalls(inspector, { batchId: parts.a.id })).body.items[0];
    // RecallListItem = the card's list fields.
    const LIST_KEYS = [
      'id',
      'sourceBatch',
      'trigger',
      'reason',
      'status',
      'blockUpstream',
      'openedAt',
      'closedAt',
      'progress',
      'batchesCount',
    ] as const;
    const listed = Object.fromEntries(LIST_KEYS.map((k) => [k, open[k]]));
    expect(instants(item)).toEqual(instants(listed));
    expectErrors(await listRecalls(inspector, { sort: 'reason,asc', status: 'DONE', trigger: 'X' }), {
      sort: ['validation.sort'],
      status: ['validation.enum'],
      trigger: ['validation.enum'],
    });
    expectErrors(await listRecalls(inspector, { from: '2026-02-30', batchId: 'x' }), {
      from: ['validation.date.format'],
      batchId: ['validation.uuid'],
    });
  });

  it('getRecallGraph: nodes as Recall.batches, edges between members by parent then child publicCode, taskStatus', async () => {
    const res = await inspector.get(`/recalls/${open.id}/graph`);
    await expectContract(res, 'getRecallGraph');
    expect(res.status, res.text).toBe(200);
    expect(res.body.recallId).toBe(open.id);
    const card = (await getRecall(inspector, open.id)).body as Recall;
    expect(
      res.body.nodes.map(
        (n: { id: string; direction: string; depth: number; statusBefore: string; status: string }) => [
          n.id,
          n.direction,
          n.depth,
          n.statusBefore,
          n.status,
        ],
      ),
    ).toEqual(card.batches.map((x) => [x.batch.id, x.direction, x.depth, x.statusBefore, x.batch.status]));
    const taskOf = new Map(card.tasks.map((t) => [t.batch.id, t.status]));
    for (const n of res.body.nodes as { id: string; taskStatus: string | null; publicCode: string }[])
      expect(n.taskStatus).toBe(taskOf.get(n.id) ?? null);
    const code = new Map(card.batches.map((x) => [x.batch.id, x.batch.publicCode]));
    const { a, o1, o2, o3 } = parts;
    const expected = [
      { parent: a.id, child: o1.id, massUsedKg: a.massKg },
      { parent: a.id, child: o2.id, massUsedKg: a.massKg },
      { parent: o2.id, child: o3.id, massUsedKg: o2.massKg },
    ].sort(
      (x, y) =>
        (code.get(x.parent)! < code.get(y.parent)!
          ? -1
          : code.get(x.parent)! > code.get(y.parent)!
            ? 1
            : 0) || (code.get(x.child)! < code.get(y.child)! ? -1 : 1),
    );
    expect(res.body.edges).toEqual(expected);
  });
});

describe('listRecallTasks and confirmRecallTask', () => {
  let parts: Awaited<ReturnType<typeof chain>>;
  let recall: Recall;
  let taskOf: (b: BatchRef) => RecallTask;
  beforeAll(async () => {
    parts = await chain();
    const res = await createRecall(inspector, {
      sourceBatchId: parts.a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    recall = res.body;
    taskOf = (b) => recall.tasks.find((t) => t.batch.id === b.id)!;
  });

  it('visibility: holders see their own tasks, INSPECTOR all (holderOrgId only for INSPECTOR, R51); filters and x-sort', async () => {
    const { retailer, processor, o1, o3 } = parts;
    const of = async (c: ApiClient, q: Record<string, string | number | boolean> = {}) => {
      const res = await listRecallTasks(c, { size: 100, ...q });
      expect(res.status, res.text).toBe(200);
      return (res.body.items as RecallTask[]).map((t) => t.id);
    };
    expect(await of(retailer.client)).toEqual([taskOf(o1).id]);
    expect(await of(processor.client)).toEqual([taskOf(o3).id]);
    expect(await of((await freshOrg('RETAILER')).client)).toEqual([]);
    expect((await of(inspector, { recallId: recall.id })).sort()).toEqual(
      recall.tasks.map((t) => t.id).sort(),
    );
    expect(await of(inspector, { recallId: recall.id, holderOrgId: retailer.orgId })).toEqual([
      taskOf(o1).id,
    ]);
    expect(await of(inspector, { recallId: recall.id, q: o3.publicCode.toLowerCase() })).toEqual([
      taskOf(o3).id,
    ]);
    expect(await of(inspector, { recallId: recall.id, status: 'CONFIRMED' })).toEqual([]);
    expect((await of(inspector, { recallId: recall.id, overdue: false })).length).toBe(2);
    expect(await of(inspector, { recallId: recall.id, overdue: true })).toEqual([]);
    const listed = (await listRecallTasks(retailer.client)).body.items[0];
    expect(instants(listed)).toEqual(instants(taskOf(o1)));
    expectErrors(await listRecallTasks(retailer.client, { holderOrgId: retailer.orgId }), {
      holderOrgId: ['validation.holderOrgId.notAllowed'],
    });
    expectErrors(await listRecallTasks(inspector, { overdue: 'yes', status: 'DONE', sort: 'status,asc' }), {
      overdue: ['validation.type'],
      status: ['validation.enum'],
      sort: ['validation.sort'],
    });
    for (const role of ['LAB', 'ADMIN'] as Role[])
      expectProblem(await listRecallTasks(await loginAs(role)), 403, 'FORBIDDEN', null);
  });

  it('confirm: Idempotency-Key, If-Match and body (one 400); invisible → 404; stale → 409 {currentVersion}; CONFIRMED + WrittenOff; replay; again → 409 {from: CONFIRMED, to: CONFIRMED}; the last task closes the recall', async () => {
    const { retailer, processor, o1, o3 } = parts;
    const t1 = taskOf(o1);
    const t3 = taskOf(o3);
    expectProblem(
      await confirmTask(retailer.client, t1.id, 1, { key: null }),
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
    expectProblem(
      await confirmTask(retailer.client, t1.id, 1, { key: 'short' }),
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
    expectErrors(await confirmTask(retailer.client, t1.id, undefined, { body: { note: 'x' } }), {
      'If-Match': ['validation.required'],
      note: ['validation.unknownField'],
    });
    expectProblem(await confirmTask(inspector, t1.id, 1), 403, 'FORBIDDEN', null);
    expectProblem(await confirmTask(processor.client, t1.id, 1), 404, 'NOT_FOUND');
    expectProblem(await confirmTask(retailer.client, UUID0, 1), 404, 'NOT_FOUND');
    expectProblem(await confirmTask(retailer.client, t1.id, 5), 409, 'VERSION_CONFLICT', {
      currentVersion: 1,
    });

    await redis().set(`pub:batch:${o1.publicCode}`, '{"stale":true}', 'EX', 300);
    const retailerUser = (await retailer.client.get('/me')).body as { id: string; fullName: string };
    const key = `k-confirm-${rand()}${rand()}`;
    const res = await confirmTask(retailer.client, t1.id, 1, { key, body: {} });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      id: t1.id,
      status: 'CONFIRMED',
      overdue: false,
      confirmedBy: { id: retailerUser.id, fullName: retailerUser.fullName },
      version: 2,
      batch: { id: o1.id, status: 'WrittenOff' },
    });
    expect(res.body.confirmedAt).not.toBeNull();
    expect(await redis().exists(`pub:batch:${o1.publicCode}`)).toBe(0);
    const h = (await retailer.client.get(`/batches/${o1.id}/history`)).body as {
      from: string;
      to: string;
      reason: string;
    }[];
    expect(h.at(-1)).toMatchObject({ from: 'Recalled', to: 'WrittenOff', reason: 'WRITTEN_OFF' });
    const replay = await confirmTask(retailer.client, t1.id, 1, { key, body: {} });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(instants(replay.body)).toEqual(instants(res.body));
    expectProblem(await confirmTask(retailer.client, t1.id, 2), 409, 'INVALID_TRANSITION', {
      from: 'CONFIRMED',
      to: 'CONFIRMED',
    });
    let card = (await getRecall(inspector, recall.id)).body as Recall;
    expect(card).toMatchObject({
      status: 'OPEN',
      closedAt: null,
      version: 1,
      progress: { confirmed: 1, total: 2 },
    });

    const since = await dbNow();
    const last = await confirmTask(processor.client, t3.id, 1); // no body
    expect(last.status, last.text).toBe(200);
    card = (await getRecall(inspector, recall.id)).body as Recall;
    expect(card).toMatchObject({
      status: 'CLOSED',
      version: 2,
      progress: { confirmed: 2, total: 2, overdue: 0 },
    });
    expect(card.closedAt).not.toBeNull();
    expect(instant(card.closedAt!)).toBe(instant(last.body.confirmedAt));
    const closeNotes = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since }))
      .map((e) => e.payload.data)
      .filter((d) => d.notificationType === 'RECALL' && d.payload.recallId === recall.id);
    expect(closeNotes).toEqual([
      {
        notificationType: 'RECALL',
        recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          recallId: recall.id,
          event: 'CLOSED',
          sourceBatchId: parts.a.id,
          publicCode: parts.a.publicCode,
          trigger: 'INSPECTOR',
        },
      },
    ]);
    const audit = await auditEntries({ entityType: 'recall', entityId: recall.id });
    expect(audit.at(-1)).toMatchObject({
      action: 'confirmRecallTask',
      diff: { status: ['OPEN', 'CLOSED'], version: [1, 2] },
    });
    const taskAudit = await auditEntries({ entityType: 'recallTask', entityId: t3.id });
    expect(taskAudit.at(-1)).toMatchObject({
      action: 'confirmRecallTask',
      diff: { status: ['OPEN', 'CONFIRMED'] },
    });
  });
});

describe('recall-task-overdue (BR-08)', () => {
  it('an OPEN task past due → OVERDUE (escalatedAt, version + 1, audit, OVERDUE to the holder and the inspectors); a task not yet due is untouched; an OVERDUE task can be confirmed', async () => {
    const { processor, retailer, a, o1, o3 } = await chain();
    const res = await createRecall(inspector, {
      sourceBatchId: a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const recall = res.body as Recall;
    const late = recall.tasks.find((t) => t.batch.id === o1.id)!;
    const onTime = recall.tasks.find((t) => t.batch.id === o3.id)!;
    const since = await dbNow();
    // Time control (Review Focus 4, scheduler test-stand period): the deadline is moved into the past in the shared DB.
    const [moved] = await fixtureWrite<{ due_at: Date }>(
      `UPDATE recall_tasks SET due_at = now() - interval '1 second' WHERE id = $1 RETURNING due_at`,
      [late.id],
    );
    const overdue = await eventually(async () => {
      const r = await listRecallTasks(inspector, { recallId: recall.id, status: 'OVERDUE' });
      return r.body.items.length === 1 ? (r.body.items[0] as RecallTask) : undefined;
    });
    expect(overdue).toMatchObject({
      id: late.id,
      status: 'OVERDUE',
      overdue: true,
      version: 2,
      holder: { id: retailer.orgId },
    });
    expect(instant(overdue.dueAt)).toBe(instant(moved!.due_at));
    expect(instant(overdue.escalatedAt!)).toBeGreaterThanOrEqual(since.getTime());
    const card = (await getRecall(inspector, recall.id)).body as Recall;
    expect(card.progress).toEqual({ confirmed: 0, total: 2, overdue: 1 });
    expect(card.tasks.find((t) => t.id === onTime.id)).toMatchObject({
      status: 'OPEN',
      version: 1,
      escalatedAt: null,
    });
    expect(
      (await listRecallTasks(retailer.client, { overdue: true })).body.items.map((t: RecallTask) => t.id),
    ).toEqual([late.id]);

    // Idempotent across ticks: an OVERDUE task is not escalated again (wait for at least two more 1 s ticks).
    await new Promise((r) => setTimeout(r, 2500));
    const ev = (await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })).filter(
      (e) => e.payload.data.notificationType === 'OVERDUE' && e.payload.data.payload.taskId === late.id,
    );
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload.requestId).toBeNull();
    const retailerName = (await inspector.get(`/organizations/${retailer.orgId}`)).body.name as string;
    expect(instants(ev[0]!.payload.data)).toEqual(
      instants({
        notificationType: 'OVERDUE',
        recipients: { userIds: [], orgIds: [retailer.orgId], orgHeadIds: [], roles: ['INSPECTOR'] },
        payload: {
          recallId: recall.id,
          taskId: late.id,
          batchId: o1.id,
          publicCode: o1.publicCode,
          dueAt: moved!.due_at,
          holderOrgId: retailer.orgId,
          holderName: retailerName,
        },
      }),
    );
    const audit = await auditEntries({ entityType: 'recallTask', entityId: late.id });
    expect(audit.filter((e) => e.action === 'system.recallTaskOverdue').length).toBe(1);
    expect(audit.at(-1)).toMatchObject({
      action: 'system.recallTaskOverdue',
      actor: null,
      diff: { status: ['OPEN', 'OVERDUE'], version: [1, 2] },
    });

    const ok = await confirmTask(retailer.client, late.id, 2);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'CONFIRMED', overdue: false, version: 3 });
    expect(instant(ok.body.escalatedAt)).toBe(instant(overdue.escalatedAt!));
    void processor;
  });
});

describe('concurrency and soft-deleted recalls', () => {
  it('the last two tasks confirmed in parallel: both 200, the recall closes exactly once (version 2, one RECALL CLOSED)', async () => {
    const { a, o1, o3, retailer, processor } = await chain();
    const res = await createRecall(inspector, {
      sourceBatchId: a.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const recall = res.body as Recall;
    const t1 = recall.tasks.find((t) => t.batch.id === o1.id)!;
    const t3 = recall.tasks.find((t) => t.batch.id === o3.id)!;
    const since = await dbNow();
    const both = await Promise.all([
      confirmTask(retailer.client, t1.id, 1),
      confirmTask(processor.client, t3.id, 1),
    ]);
    expect(
      both.map((r) => r.status),
      both.map((r) => r.text).join('\n'),
    ).toEqual([200, 200]);
    const card = (await getRecall(inspector, recall.id)).body as Recall;
    expect(card).toMatchObject({ status: 'CLOSED', version: 2, progress: { confirmed: 2, total: 2 } });
    const closeNotes = (
      await outboxEvents({ backend: BACKEND, type: 'notification.dispatch', since })
    ).filter(
      (e) => e.payload.data.notificationType === 'RECALL' && e.payload.data.payload.recallId === recall.id,
    );
    expect(closeNotes.length).toBe(1);
    const closes = (await auditEntries({ entityType: 'recall', entityId: recall.id })).filter(
      (e) => e.diff.status?.[1] === 'CLOSED',
    );
    expect(closes.length).toBe(1);
  });

  it('a task of a soft-deleted recall is hidden, not confirmable (404) and never escalated', async () => {
    const farm = await freshFarm();
    const b = await labApproved(farm);
    const res = await createRecall(inspector, {
      sourceBatchId: b.id,
      reason: reason(),
      blockUpstream: false,
    });
    expect(res.status, res.text).toBe(201);
    const task = (res.body as Recall).tasks[0]!;
    // No API deletes a recall (soft delete is R59 data state): documented fixture writes, plus a past deadline.
    await fixtureWrite(`UPDATE recalls SET deleted_at = now() WHERE id = $1`, [res.body.id]);
    await fixtureWrite(`UPDATE recall_tasks SET due_at = now() - interval '1 second' WHERE id = $1`, [
      task.id,
    ]);
    expect((await listRecallTasks(farm.client)).body.items).toEqual([]);
    expectProblem(await getRecall(inspector, res.body.id), 404, 'NOT_FOUND');
    expectProblem(await confirmTask(farm.client, task.id, 1), 404, 'NOT_FOUND');
    await new Promise((r) => setTimeout(r, 2500)); // two scheduler ticks
    const [row] = await query(`SELECT status, version FROM recall_tasks WHERE id = $1`, [task.id]);
    expect(row).toEqual({ status: 'OPEN', version: 1 });
  });
});

describe('trust rating (BR-09, eventually consistent)', () => {
  it('a full recomputation after every lab result and recall: 80 → PASS +2 → FAIL −15 and its LAB recall −10 → an inspector recall −10; audit system.ratingRecalculate', async () => {
    const farm: FreshFarm = await freshFarm();
    expect(await trustRating(farm.orgId)).toBe(80);
    const waitFor = (v: number) =>
      eventually(async () => ((await trustRating(farm.orgId)) === v ? true : undefined), 25000);
    const b1 = await rawBatch(farm);
    expect(b1.status).toBe('OnTest');
    await submitAll(await inspectorTest(b1.id), '0');
    await waitFor(82);
    const b2 = await rawBatch(farm);
    const failed = await submitAll(await inspectorTest(b2.id), '99999');
    expect(failed.recallId).not.toBeNull();
    await waitFor(57);
    const r = await createRecall(inspector, { sourceBatchId: b1.id, reason: reason(), blockUpstream: false });
    expect(r.status, r.text).toBe(201);
    await waitFor(47);
    const audit = await auditEntries({ entityType: 'organization', entityId: farm.orgId });
    const ratings = audit.filter((e) => e.action === 'system.ratingRecalculate');
    expect(ratings.at(-1)).toMatchObject({ actor: null, diff: { trustRating: [57, 47] } });
    expect(ratings.map((e) => e.diff.trustRating![1])).toEqual([82, 57, 47].slice(-ratings.length));

    // Redelivery (documented fixture writes on the outbox and the consumer claims, R55/R56): the recall's
    // recall.requested goes out again with its claim kept → nothing new; its rating.recalculate goes out again with
    // its claim removed → handled again, and a full fold (not a delta) leaves the rating at 47 with no new audit row.
    const [requested] = (await outboxEvents({ backend: BACKEND, type: 'recall.requested' })).filter(
      (e) => e.payload.data.recallId === r.body.id,
    );
    const [rating] = (await outboxEvents({ backend: BACKEND, type: 'rating.recalculate' })).filter(
      (e) => e.payload.data.sourceId === r.body.id,
    );
    expect(requested && rating).toBeTruthy();
    const opened = async () =>
      (
        await query(
          `SELECT count(*)::int AS n FROM notifications WHERE type = 'RECALL' AND payload->>'recallId' = $1`,
          [r.body.id],
        )
      )[0]!.n as number;
    await handled(r.body.id);
    const openedBefore = await opened();
    await fixtureWrite(`DELETE FROM processed_events WHERE event_id = $1`, [rating!.id]);
    await fixtureWrite(`UPDATE outbox_events SET published_at = NULL WHERE id = ANY($1::uuid[])`, [
      [requested!.id, rating!.id],
    ]);
    await eventually(async () => {
      const rows = await query(`SELECT 1 FROM processed_events WHERE event_id = $1`, [rating!.id]);
      return rows.length > 0 ? true : undefined;
    }, 25000);
    await eventually(async () => {
      const rows = await query(`SELECT 1 FROM outbox_events WHERE id = $1 AND published_at IS NOT NULL`, [
        requested!.id,
      ]);
      return rows.length > 0 ? true : undefined;
    }, 25000);
    await new Promise((res) => setTimeout(res, 1500)); // the redelivered recall.requested reaches the worker
    expect(await trustRating(farm.orgId)).toBe(47);
    expect(await opened()).toBe(openedBefore);
    const after = (await auditEntries({ entityType: 'organization', entityId: farm.orgId })).filter(
      (e) => e.action === 'system.ratingRecalculate',
    );
    expect(after.length).toBe(ratings.length);
  });
});

describe('race: acceptWaybill vs createRecall (Review Focus 1)', () => {
  it('the recall always succeeds; the acceptance wins (200) or loses with 422 BR-06 {publicCode, status: Recalled}; the task goes to the receiver either way', async () => {
    const farm = await freshFarm();
    const processor: Org = await freshOrg('PROCESSOR');
    const outcomes: number[] = [];
    for (let round = 0; round < 3; round++) {
      const b = await labApproved(farm);
      const sent = await sentWaybill(farm.client, processor.orgId, [b]);
      const [acc, rec] = await Promise.all([
        acceptWaybill(processor.client, sent, [{ batchId: b.id, massActualKg: b.massKg }]),
        createRecall(inspector, { sourceBatchId: b.id, reason: reason(), blockUpstream: false }),
      ]);
      expect(rec.status, rec.text).toBe(201);
      outcomes.push(acc.status);
      const r = rec.body as Recall;
      if (acc.status === 200) {
        expect(r.batches[0]!.statusBefore).toBe('Accepted');
      } else {
        expectProblem(acc, 422, 'BUSINESS_RULE', { publicCode: b.publicCode, status: 'Recalled' });
        expect(acc.body.rule).toBe('BR-06');
        expect(r.batches[0]!.statusBefore).toBe('InTransit');
      }
      expect(r.tasks.map((t) => t.holder.id)).toEqual([processor.orgId]);
      expect((await getBatch(farm.client, b.id)).body.status).toBe('Recalled');
    }
    expect(outcomes.every((s) => s === 200 || s === 422)).toBe(true);
    // Which side wins is the scheduler's choice (not forceable over HTTP); the mix is logged for the record.
    console.info(`accept vs recall outcomes: ${outcomes.join(', ')}`);
  });
});
