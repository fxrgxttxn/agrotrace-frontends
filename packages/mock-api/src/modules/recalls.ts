import { canBatchTransition, canEntityTransition } from '../domain/transitions.js';
import { compareCodePoints, isOverdue, shouldCloseRecall } from '@agrotrace/domain';
import { RecallCreateSchema, RecallTaskConfirmSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { invalidTransition, notFound, validation, versionConflict } from '../http/problem.js';
import { notify } from '../domain/notify.js';
import { ifMatch, runRecallEngine, transition } from '../domain/production.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { Principal, RecallRow, RecallTaskRow } from '../store/types.js';
import { actorRef, batchListItem, orgRef, productRef } from '../views/refs.js';

const TRIGGERS = ['LAB', 'INSPECTOR', 'COMPLAINT'] as const;
const TASK_STATUSES = ['OPEN', 'CONFIRMED', 'OVERDUE'] as const;
const DIRECTION_ORDER = { SOURCE: 0, DOWN: 1, UP: 2 } as const;

const taskOverdue = (m: Mock, t: RecallTaskRow): boolean =>
  t.status !== 'CONFIRMED' && isOverdue({ dueAt: t.due_at, now: m.store.nowIso() }).overdue;

export function recallTaskView(m: Mock, t: RecallTaskRow) {
  const recall = m.store.must('recalls', t.recall_id);
  return {
    id: t.id,
    recallId: t.recall_id,
    recallReason: recall.reason,
    batch: batchListItem(m, m.store.must('batches', t.batch_id)),
    holder: orgRef(m, t.holder_org_id),
    dueAt: t.due_at,
    status: t.status,
    overdue: taskOverdue(m, t),
    escalatedAt: t.escalated_at,
    confirmedAt: t.confirmed_at,
    confirmedBy: actorRef(m, t.confirmed_by),
    createdAt: t.created_at,
    version: t.version,
  };
}

const tasksOf = (m: Mock, r: RecallRow): RecallTaskRow[] => m.store.t.recall_tasks.filter((t) => t.recall_id === r.id);

function orderedMembers(m: Mock, r: RecallRow) {
  return m.store.t.recall_batches
    .filter((rb) => rb.recall_id === r.id)
    .map((rb) => ({ rb, b: m.store.must('batches', rb.batch_id) }))
    .sort(
      (x, y) =>
        DIRECTION_ORDER[x.rb.direction] - DIRECTION_ORDER[y.rb.direction] ||
        x.rb.depth - y.rb.depth ||
        compareCodePoints(x.b.public_code, y.b.public_code),
    );
}

export function recallListItem(m: Mock, r: RecallRow) {
  const tasks = tasksOf(m, r);
  return {
    id: r.id,
    sourceBatch: batchListItem(m, m.store.must('batches', r.source_batch_id)),
    trigger: r.trigger,
    reason: r.reason,
    status: r.status,
    blockUpstream: r.block_upstream,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    progress: {
      confirmed: tasks.filter((t) => t.status === 'CONFIRMED').length,
      total: tasks.length,
      overdue: tasks.filter((t) => taskOverdue(m, t)).length,
    },
    batchesCount: m.store.t.recall_batches.filter((rb) => rb.recall_id === r.id).length,
  };
}

export function recallView(m: Mock, r: RecallRow) {
  const code = (t: RecallTaskRow) => m.store.must('batches', t.batch_id).public_code;
  return {
    ...recallListItem(m, r),
    openedBy: actorRef(m, r.created_by),
    labTestId: r.lab_test_id,
    complaintId: r.complaint_id,
    batches: orderedMembers(m, r).map(({ rb, b }) => ({ batch: batchListItem(m, b), direction: rb.direction, depth: rb.depth, statusBefore: rb.status_before })),
    tasks: tasksOf(m, r)
      .sort((x, y) => Date.parse(x.due_at) - Date.parse(y.due_at) || compareCodePoints(code(x), code(y)))
      .map((t) => recallTaskView(m, t)),
    version: r.version,
  };
}

function liveRecall(m: Mock, id: string): RecallRow {
  const r = m.store.get('recalls', id);
  if (!r || r.deleted_at !== null) throw notFound();
  return r;
}

const canSeeTask = (p: Principal, t: RecallTaskRow): boolean =>
  p.roles.includes('INSPECTOR') || (p.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR' || r === 'RETAILER') && t.holder_org_id === p.orgId);

export const recallsHandlers: Record<string, Handler> = {
  listRecalls(ctx) {
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['openedAt', 'closedAt'], default: 'openedAt,desc' });
    const text = q.q();
    const status = q.enumOf('status', ['OPEN', 'CLOSED'] as const);
    const triggers = q.enumList('trigger', TRIGGERS);
    const batchId = q.uuid('batchId');
    const range = q.dateRange();
    q.done();
    let rows = ctx.store.t.recalls.filter((r) => r.deleted_at === null);
    if (status) rows = rows.filter((r) => r.status === status);
    if (triggers) rows = rows.filter((r) => triggers.includes(r.trigger));
    if (batchId) rows = rows.filter((r) => ctx.store.t.recall_batches.some((rb) => rb.recall_id === r.id && rb.batch_id === batchId));
    if (range.from || range.to) rows = rows.filter((r) => inDateRange(range, r.opened_at));
    if (text !== undefined) rows = rows.filter((r) => contains(ctx.store.must('batches', r.source_batch_id).public_code, text));
    const key = sort.field === 'closedAt' ? (r: RecallRow) => r.closed_at : (r: RecallRow) => r.opened_at;
    const pg = paginate(sortBy(rows, key, 'time', sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((r) => recallListItem(ctx, r)) });
  },

  async createRecall(ctx) {
    const p = ctx.user();
    const input = parseBody(RecallCreateSchema, await ctx.json());
    const b = ctx.store.get('batches', input.sourceBatchId.toLowerCase());
    if (!b || b.deleted_at !== null) throw validation({ sourceBatchId: ['validation.notFound'] });
    const { recall, created } = runRecallEngine(ctx.store, b, {
      trigger: 'INSPECTOR',
      reason: input.reason,
      blockUpstream: input.blockUpstream,
      actorId: p.userId,
    });
    return json(created ? 201 : 200, recallView(ctx, recall));
  },

  getRecall(ctx) {
    return json(200, recallView(ctx, liveRecall(ctx, uuidParam(ctx.params.id))));
  },

  getRecallGraph(ctx) {
    const r = liveRecall(ctx, uuidParam(ctx.params.id));
    const members = orderedMembers(ctx, r);
    const ids = new Set(members.map((x) => x.b.id));
    const code = (id: string) => ctx.store.must('batches', id).public_code;
    return json(200, {
      recallId: r.id,
      nodes: members.map(({ rb, b }) => ({
        id: b.id,
        publicCode: b.public_code,
        product: productRef(ctx, b.product_id),
        status: b.status,
        statusBefore: rb.status_before,
        holder: orgRef(ctx, b.holder_org_id),
        direction: rb.direction,
        depth: rb.depth,
        taskStatus: tasksOf(ctx, r).find((t) => t.batch_id === b.id)?.status ?? null,
      })),
      edges: ctx.store.t.batch_links
        .filter((l) => ids.has(l.parent_batch_id) && ids.has(l.child_batch_id))
        .sort((x, y) => compareCodePoints(code(x.parent_batch_id), code(y.parent_batch_id)) || compareCodePoints(code(x.child_batch_id), code(y.child_batch_id)))
        .map((l) => ({ parent: l.parent_batch_id, child: l.child_batch_id, massUsedKg: l.mass_used_kg })),
    });
  },

  listRecallTasks(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['dueAt', 'createdAt', 'confirmedAt'], default: 'dueAt,asc' });
    const text = q.q();
    const statuses = q.enumList('status', TASK_STATUSES);
    const overdue = q.bool('overdue');
    const recallId = q.uuid('recallId');
    let holderOrgId: string | undefined;
    if (p.roles.includes('INSPECTOR')) holderOrgId = q.uuid('holderOrgId');
    else q.notAllowed('holderOrgId');
    q.done();
    let rows = ctx.store.t.recall_tasks.filter((t) => canSeeTask(p, t));
    if (statuses) rows = rows.filter((t) => statuses.includes(t.status));
    if (overdue !== undefined) rows = rows.filter((t) => taskOverdue(ctx, t) === overdue);
    if (recallId) rows = rows.filter((t) => t.recall_id === recallId);
    if (holderOrgId) rows = rows.filter((t) => t.holder_org_id === holderOrgId);
    if (text !== undefined) rows = rows.filter((t) => contains(ctx.store.must('batches', t.batch_id).public_code, text));
    const key = { dueAt: (t: RecallTaskRow) => t.due_at, createdAt: (t: RecallTaskRow) => t.created_at, confirmedAt: (t: RecallTaskRow) => t.confirmed_at }[
      sort.field as 'dueAt'
    ];
    const pg = paginate(sortBy(rows, key, 'time', sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((t) => recallTaskView(ctx, t)) });
  },

  async confirmRecallTask(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const body = await ctx.json(true);
    if (body !== undefined) parseBody(RecallTaskConfirmSchema, body);
    const s = ctx.store;
    const task = s.get('recall_tasks', id);
    if (!task || task.holder_org_id !== p.orgId) throw notFound();
    if (task.version !== version) throw versionConflict(task.version);
    if (!canEntityTransition('recallTask', task.status, 'CONFIRMED')) throw invalidTransition({ from: task.status, to: 'CONFIRMED' });
    const b = s.must('batches', task.batch_id);
    if (!canBatchTransition(b.status, 'WrittenOff')) throw invalidTransition({ from: b.status, to: 'WrittenOff', publicCode: b.public_code });
    const now = s.nowIso();
    transition(s, b, 'WrittenOff', 'WRITTEN_OFF', p.userId);
    s.touch('recallTask', task);
    s.patch(task, { status: 'CONFIRMED', confirmed_at: now, confirmed_by: p.userId, version: task.version + 1, updated_at: now });
    const recall = s.must('recalls', task.recall_id);
    if (recall.status === 'OPEN' && shouldCloseRecall({ taskStatuses: tasksOf(ctx, recall).map((t) => t.status) }).close) {
      s.touch('recall', recall);
      s.patch(recall, { status: 'CLOSED', closed_at: now, version: recall.version + 1, updated_at: now });
      const source = s.must('batches', recall.source_batch_id);
      notify(s, 'RECALL', { roles: ['INSPECTOR'] }, {
        recallId: recall.id,
        event: 'CLOSED',
        sourceBatchId: source.id,
        publicCode: source.public_code,
        trigger: recall.trigger,
      });
    }
    return json(200, recallTaskView(ctx, task));
  },
};
