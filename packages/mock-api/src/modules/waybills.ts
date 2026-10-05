import { canBatchTransition, canEntityTransition } from '../domain/transitions.js';
import { checkDiscrepancy, checkWaitingPeriod, compareCodePoints, compareDecimalStrings } from '@agrotrace/domain';
import { WaybillAcceptSchema, WaybillCreateSchema, WaybillRejectSchema } from '@agrotrace/validation';
import { massWire, parseBody } from '../http/body.js';
import { json, noContent, type Ctx, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { businessRule, forbidden, invalidTransition, notFound, validation, versionConflict } from '../http/problem.js';
import { notify } from '../domain/notify.js';
import { ifMatch, transition } from '../domain/production.js';
import { canSeeWaybill, seesAll, visibleBatchIds } from '../domain/visibility.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { BatchRow, Principal, WaybillItemRow, WaybillRow } from '../store/types.js';
import { batchListItem, orgRef } from '../views/refs.js';

const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
const LIST_SORT = { fields: ['createdAt', 'sentAt', 'acceptedAt', 'number'], default: 'createdAt,desc' };

export function waybillItems(m: Mock, w: WaybillRow): { item: WaybillItemRow; batch: BatchRow }[] {
  return m.store.t.waybill_items
    .filter((i) => i.waybill_id === w.id)
    .map((item) => ({ item, batch: m.store.must('batches', item.batch_id) }))
    .sort((a, b) => compareCodePoints(a.batch.public_code, b.batch.public_code));
}

function actions(p: Principal, w: WaybillRow): string[] {
  const out: string[] = [];
  const has = (...r: string[]) => p.roles.some((x) => r.includes(x));
  if (canEntityTransition('waybill', w.status, 'SENT') && w.sender_org_id === p.orgId && has('FARMER', 'PROCESSOR')) out.push('send', 'delete');
  if (canEntityTransition('waybill', w.status, 'ACCEPTED') && w.receiver_org_id === p.orgId && has('PROCESSOR', 'RETAILER')) out.push('accept', 'reject');
  return out;
}

export function waybillView(m: Mock, p: Principal, w: WaybillRow) {
  return {
    id: w.id,
    number: w.number,
    status: w.status,
    sender: orgRef(m, w.sender_org_id),
    receiver: orgRef(m, w.receiver_org_id),
    items: waybillItems(m, w).map(({ item, batch }) => {
      const d = item.mass_actual_kg !== null ? checkDiscrepancy({ declaredKg: item.mass_declared_kg, actualKg: item.mass_actual_kg }) : null;
      return {
        batch: batchListItem(m, batch),
        massDeclaredKg: item.mass_declared_kg,
        massActualKg: item.mass_actual_kg,
        discrepancyPercent: d && 'percent' in d ? d.percent : null,
        discrepancyAct: item.discrepancy_act,
      };
    }),
    createdAt: w.created_at,
    sentAt: w.sent_at,
    acceptedAt: w.accepted_at,
    rejectReason: w.reject_reason,
    version: w.version,
    actions: actions(p, w),
  };
}

function visibleWaybill(ctx: Ctx, id: string): WaybillRow {
  const w = ctx.store.get('waybills', id);
  if (!canSeeWaybill(ctx.user(), w)) throw notFound();
  return w;
}

export const waybillsHandlers: Record<string, Handler> = {
  listWaybills(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page(LIST_SORT);
    const text = q.q();
    let direction: 'incoming' | 'outgoing' | undefined;
    if (seesAll(p)) q.notAllowed('direction');
    else direction = q.enumOf('direction', ['incoming', 'outgoing'] as const);
    const statuses = q.enumList('status', STATUSES);
    const counterparty = q.uuid('counterpartyOrgId');
    const range = q.dateRange();
    q.done();
    let rows = ctx.store.t.waybills.filter((w) => canSeeWaybill(p, w));
    if (direction === 'outgoing') rows = rows.filter((w) => w.sender_org_id === p.orgId);
    if (direction === 'incoming') rows = rows.filter((w) => w.receiver_org_id === p.orgId);
    if (statuses) rows = rows.filter((w) => statuses.includes(w.status));
    if (counterparty)
      rows = rows.filter((w) =>
        seesAll(p)
          ? w.sender_org_id === counterparty || w.receiver_org_id === counterparty
          : (w.sender_org_id === p.orgId ? w.receiver_org_id : w.sender_org_id) === counterparty,
      );
    if (range.from || range.to) rows = rows.filter((w) => inDateRange(range, w.created_at));
    if (text !== undefined)
      rows = rows.filter((w) => contains(w.number, text) || waybillItems(ctx, w).some(({ batch }) => contains(batch.public_code, text)));
    const keys = {
      createdAt: [(w: WaybillRow) => w.created_at, 'time'],
      sentAt: [(w: WaybillRow) => w.sent_at, 'time'],
      acceptedAt: [(w: WaybillRow) => w.accepted_at, 'time'],
      number: [(w: WaybillRow) => w.number, 'text'],
    } as const;
    const [key, kind] = keys[sort.field as keyof typeof keys];
    const pg = paginate(sortBy(rows, key, kind, sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((w) => waybillView(ctx, p, w)) });
  },

  async createWaybill(ctx) {
    const p = ctx.user();
    const input = parseBody(WaybillCreateSchema, await ctx.json(), (raw, add) => massWire(raw, add, [['items', 'massDeclaredKg']]));
    const s = ctx.store;
    const errors: Record<string, string[]> = {};
    const receiver = s.get('organizations', input.receiverOrgId.toLowerCase());
    if (!receiver || receiver.status !== 'ACTIVE' || receiver.deleted_at !== null) errors.receiverOrgId = ['validation.notFound'];
    else if (receiver.type !== 'PROCESSOR' && receiver.type !== 'RETAILER') errors.receiverOrgId = ['validation.receiver.type'];
    else if (receiver.id === p.orgId) errors.receiverOrgId = ['validation.receiver.self'];
    const visible = visibleBatchIds(s, p);
    const seen = new Set<string>();
    const batches: BatchRow[] = [];
    input.items.forEach((it, i) => {
      const id = it.batchId.toLowerCase();
      if (seen.has(id)) {
        errors[`items[${i}].batchId`] = ['validation.duplicate'];
        return;
      }
      seen.add(id);
      const b = s.get('batches', id);
      if (!b || !visible.has(b.id)) {
        errors[`items[${i}].batchId`] = ['validation.notFound'];
        return;
      }
      if (compareDecimalStrings(it.massDeclaredKg, b.mass_kg) > 0) errors[`items[${i}].massDeclaredKg`] = ['validation.mass.exceedsBatch'];
      batches[i] = b;
    });
    if (Object.keys(errors).length > 0) throw validation(errors);
    for (const b of batches) if (b.holder_org_id !== p.orgId) throw forbidden({ reason: 'NOT_HOLDER', publicCode: b.public_code }, 'Not the batch holder');
    s.markDirty();
    s.seq.waybill += 1;
    const now = s.nowIso();
    const w = s.insert('waybills', {
      id: s.id('waybill'),
      number: `WB-${new Date(s.now()).getUTCFullYear()}-${String(s.seq.waybill).padStart(6, '0')}`,
      sender_org_id: p.orgId,
      receiver_org_id: receiver!.id,
      status: 'DRAFT',
      reject_reason: null,
      sent_at: null,
      accepted_at: null,
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: p.userId,
      deleted_at: null,
    });
    s.created('waybill', w);
    input.items.forEach((it, i) =>
      s.insert('waybill_items', {
        id: s.id('waybill_item'),
        waybill_id: w.id,
        batch_id: batches[i]!.id,
        mass_declared_kg: it.massDeclaredKg,
        mass_actual_kg: null,
        discrepancy_act: null,
      }),
    );
    return json(201, waybillView(ctx, p, w));
  },

  getWaybill(ctx) {
    const w = visibleWaybill(ctx, uuidParam(ctx.params.id));
    return json(200, waybillView(ctx, ctx.user(), w));
  },

  deleteWaybill(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const w = visibleWaybill(ctx, id);
    if (w.sender_org_id !== p.orgId) throw forbidden({ reason: 'NOT_SENDER' }, 'Not the waybill sender');
    if (w.version !== version) throw versionConflict(w.version);
    if (!canEntityTransition('waybill', w.status, 'DELETED')) throw invalidTransition({ from: w.status, to: 'DELETED' });
    ctx.store.touch('waybill', w);
    ctx.store.patch(w, { deleted_at: ctx.store.nowIso() });
    return noContent();
  },

  sendWaybill(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const w = visibleWaybill(ctx, id);
    const s = ctx.store;
    if (w.sender_org_id !== p.orgId) throw forbidden({ reason: 'NOT_SENDER' }, 'Not the waybill sender');
    if (w.version !== version) throw versionConflict(w.version);
    if (!canEntityTransition('waybill', w.status, 'SENT')) throw invalidTransition({ from: w.status, to: 'SENT' });
    const shipDate = s.nowIso().slice(0, 10);
    const items = waybillItems(ctx, w);
    for (const { batch } of items) {
      if (batch.holder_org_id !== p.orgId) throw forbidden({ reason: 'NOT_HOLDER', publicCode: batch.public_code }, 'Not the batch holder');
      if (batch.status === 'Blocked' || batch.status === 'Recalled')
        throw businessRule('BR-06', { publicCode: batch.public_code, status: batch.status });
      if (!canBatchTransition(batch.status, 'InTransit'))
        throw invalidTransition({ from: batch.status, to: 'InTransit', publicCode: batch.public_code });
      if (batch.kind === 'RAW') {
        const treatments = s.t.treatments
          .filter((t) => t.field_id === batch.field_id && t.deleted_at === null)
          .map((t) => {
            const sub = s.must('substances', t.substance_id);
            return { substance: sub.name, appliedAt: t.applied_at, waitingPeriodDays: sub.waiting_period_days };
          });
        const br01 = checkWaitingPeriod({ shipDate, treatments });
        if (!br01.ok) throw businessRule('BR-01', { publicCode: batch.public_code, until: br01.until, substance: br01.substance });
      }
    }
    s.touch('waybill', w);
    s.patch(w, { status: 'SENT', sent_at: s.nowIso(), version: w.version + 1, updated_at: s.nowIso() });
    for (const { batch } of items) transition(s, batch, 'InTransit', 'WAYBILL_SENT', p.userId);
    const sender = s.must('organizations', p.orgId);
    notify(s, 'WAYBILL_INCOMING', { orgs: [w.receiver_org_id] }, {
      waybillId: w.id,
      number: w.number,
      senderOrgId: sender.id,
      senderName: sender.name,
      itemsCount: items.length,
    });
    return json(200, waybillView(ctx, p, w));
  },

  async acceptWaybill(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const input = parseBody(WaybillAcceptSchema, await ctx.json(), (raw, add) => massWire(raw, add, [['items', 'massActualKg']]));
    const w = visibleWaybill(ctx, id);
    const s = ctx.store;
    if (w.receiver_org_id !== p.orgId) throw forbidden({ reason: 'NOT_RECEIVER' }, 'Not the waybill receiver');
    if (w.version !== version) throw versionConflict(w.version);
    if (!canEntityTransition('waybill', w.status, 'ACCEPTED')) throw invalidTransition({ from: w.status, to: 'ACCEPTED' });
    const items = waybillItems(ctx, w);
    const byBatch = new Map(input.items.map((i) => [i.batchId.toLowerCase(), i]));
    if (byBatch.size !== input.items.length || byBatch.size !== items.length || items.some(({ batch }) => !byBatch.has(batch.id)))
      throw validation({ items: ['validation.items.mismatch'] });
    for (const { item, batch } of items) {
      if (batch.status === 'Blocked' || batch.status === 'Recalled')
        throw businessRule('BR-06', { publicCode: batch.public_code, status: batch.status });
      if (!canBatchTransition(batch.status, 'Accepted')) throw invalidTransition({ from: batch.status, to: 'Accepted', publicCode: batch.public_code });
      const a = byBatch.get(batch.id)!;
      const d = checkDiscrepancy({ declaredKg: item.mass_declared_kg, actualKg: a.massActualKg });
      if ('percent' in d && d.actRequired && a.discrepancyAct === undefined)
        throw businessRule('BR-07', { publicCode: batch.public_code, percent: d.percent });
    }
    const now = s.nowIso();
    s.touch('waybill', w);
    s.patch(w, { status: 'ACCEPTED', accepted_at: now, version: w.version + 1, updated_at: now });
    for (const { item, batch } of items) {
      const a = byBatch.get(batch.id)!;
      s.patch(item, { mass_actual_kg: a.massActualKg, discrepancy_act: a.discrepancyAct ?? null });
      transition(s, batch, 'Accepted', 'WAYBILL_ACCEPTED', p.userId);
      s.patch(batch, { holder_org_id: p.orgId, mass_kg: a.massActualKg });
    }
    return json(200, waybillView(ctx, p, w));
  },

  async rejectWaybill(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const input = parseBody(WaybillRejectSchema, await ctx.json());
    const w = visibleWaybill(ctx, id);
    const s = ctx.store;
    if (w.receiver_org_id !== p.orgId) throw forbidden({ reason: 'NOT_RECEIVER' }, 'Not the waybill receiver');
    if (w.version !== version) throw versionConflict(w.version);
    if (!canEntityTransition('waybill', w.status, 'REJECTED')) throw invalidTransition({ from: w.status, to: 'REJECTED' });
    s.touch('waybill', w);
    s.patch(w, { status: 'REJECTED', reject_reason: input.reason, version: w.version + 1, updated_at: s.nowIso() });
    for (const { batch } of waybillItems(ctx, w)) {
      if (canBatchTransition(batch.status, 'Approved') && batch.status === 'InTransit') {
        transition(s, batch, 'Approved', 'WAYBILL_REJECTED', p.userId);
        continue;
      }
      for (const task of s.t.recall_tasks) {
        if (task.batch_id !== batch.id || task.holder_org_id !== w.receiver_org_id) continue;
        if (!canEntityTransition('recallTask', task.status, 'CONFIRMED')) continue;
        s.touch('recallTask', task);
        s.patch(task, { holder_org_id: w.sender_org_id, version: task.version + 1, updated_at: s.nowIso() });
        notify(s, 'RECALL_TASK', { orgs: [w.sender_org_id] }, {
          recallId: task.recall_id,
          taskId: task.id,
          batchId: batch.id,
          publicCode: batch.public_code,
          dueAt: task.due_at,
          event: 'REASSIGNED',
        });
      }
    }
    return json(200, waybillView(ctx, p, w));
  },
};
