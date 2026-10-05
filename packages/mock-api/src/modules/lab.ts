import { canEntityTransition } from '../domain/transitions.js';
import { compareCodePoints, compareDecimalStrings, concludeLabTest, isOverdue } from '@agrotrace/domain';
import { LabResultsInputSchema, LabSampleRequestSchema, LabTestCreateSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, type Ctx, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { invalidTransition, notFound, validation, versionConflict } from '../http/problem.js';
import { contentDisposition, fileRef, insertBytesFile, liveFile, softDeleteFile } from '../domain/files.js';
import { notify } from '../domain/notify.js';
import { ifMatch, insertLabTest, LAB_OPEN, RECALL_REASON_LAB, runRecallEngine, transition } from '../domain/production.js';
import { recalculateRating } from '../domain/rating.js';
import { readUpload } from '../domain/uploads.js';
import { canSeeLabTest, seesAll, visibleBatchIds } from '../domain/visibility.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { LabTestRow, Principal } from '../store/types.js';
import { batchListItem, orgRef } from '../views/refs.js';
import { CACHE_PRIVATE, sendFile } from './files.js';

export const PROTOCOL_MAX_BYTES = 10 * 1024 * 1024;
const STATUSES = ['QUEUED', 'SAMPLED', 'DONE', 'ESCALATED', 'CANCELLED'] as const;
const REASONS = ['PLANNED', 'RISK', 'COMPLAINT', 'INSPECTOR'] as const;
const LIST_SORT = { fields: ['dueAt', 'createdAt', 'completedAt'], default: 'dueAt,asc' };

export function dec6(v: string): string {
  const [i, f = ''] = v.split('.');
  return `${BigInt(i!)}.${f.padEnd(6, '0').slice(0, 6)}`;
}

const overdueOf = (m: Mock, t: LabTestRow): boolean =>
  LAB_OPEN.has(t.status) && isOverdue({ dueAt: t.due_at, now: m.store.nowIso() }).overdue;

export function labTestListItem(m: Mock, t: LabTestRow) {
  return {
    id: t.id,
    batch: batchListItem(m, m.store.must('batches', t.batch_id)),
    lab: orgRef(m, t.lab_org_id),
    reason: t.reason,
    status: t.status,
    conclusion: t.conclusion,
    dueAt: t.due_at,
    overdue: overdueOf(m, t),
    createdAt: t.created_at,
    sampledAt: t.sampled_at,
    completedAt: t.completed_at,
    hasProtocol: !!liveFile(m.store, t.protocol_file_id),
  };
}

function currentNorms(m: Mock, t: LabTestRow) {
  const b = m.store.must('batches', t.batch_id);
  return m.store.t.norms
    .filter((n) => n.product_id === b.product_id)
    .map((n) => ({ n, ind: m.store.must('indicators', n.indicator_id) }))
    .filter(({ ind }) => ind.deleted_at === null)
    .sort((x, y) => compareCodePoints(x.ind.name, y.ind.name) || compareCodePoints(x.ind.id, y.ind.id))
    .map(({ n, ind }) => ({ indicatorId: ind.id, name: ind.name, unit: ind.unit, maxValue: dec6(n.max_value) }));
}

function results(m: Mock, t: LabTestRow) {
  return m.store.t.lab_results
    .filter((r) => r.lab_test_id === t.id)
    .map((r) => ({ r, ind: m.store.must('indicators', r.indicator_id) }))
    .sort((x, y) => compareCodePoints(x.ind.name, y.ind.name) || compareCodePoints(x.ind.id, y.ind.id))
    .map(({ r, ind }) => ({
      indicatorId: ind.id,
      name: ind.name,
      unit: ind.unit,
      value: dec6(r.value),
      normValue: dec6(r.norm_value_snapshot),
      isExceeded: r.is_exceeded,
    }));
}

export function labTestView(m: Mock, p: Principal, t: LabTestRow) {
  const res = t.status === 'DONE' ? results(m, t) : [];
  const protocol = liveFile(m.store, t.protocol_file_id);
  const isLab = p.roles.includes('LAB');
  const actions: string[] = [];
  if (isLab && canEntityTransition('labTest', t.status, 'SAMPLED')) actions.push('sample');
  if (isLab && canEntityTransition('labTest', t.status, 'DONE')) actions.push('submitResults');
  if (isLab && t.status !== 'CANCELLED') actions.push('uploadProtocol');
  return {
    ...labTestListItem(m, t),
    escalatedAt: t.escalated_at,
    results: res,
    protocol: protocol ? fileRef(m.cfg, protocol) : null,
    norms:
      t.status === 'DONE'
        ? res.map((r) => ({ indicatorId: r.indicatorId, name: r.name, unit: r.unit, maxValue: r.normValue }))
        : currentNorms(m, t),
    recallId: t.recall_id,
    version: t.version,
    actions,
  };
}

function visibleTest(ctx: Ctx, id: string): LabTestRow {
  const t = ctx.store.get('lab_tests', id);
  if (!canSeeLabTest(ctx.store, ctx.user(), t)) throw notFound();
  return t;
}

export const labHandlers: Record<string, Handler> = {
  listLabTests(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page(LIST_SORT);
    const text = q.q();
    const statuses = q.enumList('status', STATUSES);
    const reasons = q.enumList('reason', REASONS);
    const conclusion = q.enumOf('conclusion', ['PASS', 'FAIL'] as const);
    const overdue = q.bool('overdue');
    const batchId = q.uuid('batchId');
    let labOrgId: string | undefined;
    if (seesAll(p)) labOrgId = q.uuid('labOrgId');
    else q.notAllowed('labOrgId');
    const range = q.dateRange();
    q.done();
    const batches = visibleBatchIds(ctx.store, p);
    let rows = ctx.store.t.lab_tests.filter((t) => canSeeLabTest(ctx.store, p, t, batches));
    if (statuses) rows = rows.filter((t) => statuses.includes(t.status));
    if (reasons) rows = rows.filter((t) => reasons.includes(t.reason));
    if (conclusion) rows = rows.filter((t) => t.conclusion === conclusion);
    if (overdue !== undefined) rows = rows.filter((t) => overdueOf(ctx, t) === overdue);
    if (batchId) rows = rows.filter((t) => t.batch_id === batchId);
    if (labOrgId) rows = rows.filter((t) => t.lab_org_id === labOrgId);
    if (range.from || range.to) rows = rows.filter((t) => inDateRange(range, t.created_at));
    if (text !== undefined) rows = rows.filter((t) => contains(ctx.store.must('batches', t.batch_id).public_code, text));
    const key = { dueAt: (t: LabTestRow) => t.due_at, createdAt: (t: LabTestRow) => t.created_at, completedAt: (t: LabTestRow) => t.completed_at }[
      sort.field as 'dueAt'
    ];
    const pg = paginate(sortBy(rows, key, 'time', sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((t) => labTestListItem(ctx, t)) });
  },

  async createLabTest(ctx) {
    const p = ctx.user();
    const input = parseBody(LabTestCreateSchema, await ctx.json());
    const s = ctx.store;
    const errors: Record<string, string[]> = {};
    const b = s.get('batches', input.batchId.toLowerCase());
    if (!b || b.deleted_at !== null) errors.batchId = ['validation.notFound'];
    const lab = s.get('organizations', input.labOrgId.toLowerCase());
    if (!lab || lab.status !== 'ACTIVE' || lab.deleted_at !== null) errors.labOrgId = ['validation.notFound'];
    else if (lab.type !== 'LAB') errors.labOrgId = ['validation.labOrg.type'];
    if (Object.keys(errors).length > 0) throw validation(errors);
    const t = insertLabTest(s, b!, lab!, 'INSPECTOR', p.userId);
    return json(201, labTestView(ctx, p, t));
  },

  getLabTest(ctx) {
    const t = visibleTest(ctx, uuidParam(ctx.params.id));
    return json(200, labTestView(ctx, ctx.user(), t));
  },

  async registerLabSample(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const body = await ctx.json(true);
    if (body !== undefined) parseBody(LabSampleRequestSchema, body);
    const t = visibleTest(ctx, id);
    if (t.version !== version) throw versionConflict(t.version);
    if (!canEntityTransition('labTest', t.status, 'SAMPLED')) throw invalidTransition({ from: t.status, to: 'SAMPLED' });
    ctx.store.touch('labTest', t);
    ctx.store.patch(t, { status: 'SAMPLED', sampled_at: ctx.store.nowIso(), version: t.version + 1, updated_at: ctx.store.nowIso() });
    return json(200, labTestView(ctx, p, t));
  },

  async submitLabResults(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const version = ifMatch(ctx.request);
    const input = parseBody(LabResultsInputSchema, await ctx.json());
    const t = visibleTest(ctx, id);
    const s = ctx.store;
    if (t.version !== version) throw versionConflict(t.version);
    if (!canEntityTransition('labTest', t.status, 'DONE')) throw invalidTransition({ from: t.status, to: 'DONE' });
    const norms = currentNorms(ctx, t);
    const ids = input.results.map((r) => r.indicatorId.toLowerCase());
    const expected = new Set(norms.map((n) => n.indicatorId));
    if (ids.length !== expected.size || ids.some((x) => !expected.has(x)) || new Set(ids).size !== ids.length)
      throw validation({ results: ['validation.results.mismatch'] });
    const rows = input.results.map((r) => {
      const norm = norms.find((n) => n.indicatorId === r.indicatorId.toLowerCase())!;
      return { indicatorId: norm.indicatorId, value: dec6(r.value), maxValue: norm.maxValue };
    });
    const concl = concludeLabTest({ results: rows });
    if (!('conclusion' in concl)) throw validation({ results: ['validation.results.mismatch'] });
    for (const r of rows)
      s.insert('lab_results', {
        id: s.id('lab_result'),
        lab_test_id: t.id,
        indicator_id: r.indicatorId,
        value: r.value,
        norm_value_snapshot: r.maxValue,
        is_exceeded: compareDecimalStrings(r.value, r.maxValue) > 0,
      });
    const now = s.nowIso();
    s.touch('labTest', t);
    s.patch(t, { status: 'DONE', conclusion: concl.conclusion, completed_at: now, sampled_at: t.sampled_at ?? now, version: t.version + 1, updated_at: now });
    const b = s.must('batches', t.batch_id);
    if (b.status === 'OnTest') transition(s, b, concl.conclusion === 'PASS' ? 'Approved' : 'Blocked', concl.conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL', p.userId);
    if (concl.conclusion === 'FAIL') {
      const { recall } = runRecallEngine(s, b, { trigger: 'LAB', reason: RECALL_REASON_LAB, blockUpstream: false, labTestId: t.id, actorId: p.userId });
      s.patch(t, { recall_id: recall.id });
    }
    const origin = b.origin_org_id;
    const holder = b.holder_org_id;
    notify(
      s,
      'LAB_RESULT',
      { orgs: holder !== origin ? [origin, holder] : [origin], roles: t.reason === 'INSPECTOR' || t.reason === 'COMPLAINT' ? ['INSPECTOR'] : [] },
      {
        labTestId: t.id,
        batchId: b.id,
        publicCode: b.public_code,
        productName: s.must('products', b.product_id).name,
        conclusion: t.conclusion,
        recallId: t.recall_id,
      },
    );
    recalculateRating(s, origin);
    return json(200, labTestView(ctx, p, t));
  },

  async uploadLabProtocol(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    let t!: ReturnType<typeof visibleTest>;
    const up = await readUpload(ctx, PROTOCOL_MAX_BYTES, ['application/pdf'], () => {
      t = visibleTest(ctx, id);
    });
    const file = insertBytesFile(ctx.store, { kind: 'LAB_PROTOCOL', originalName: up.name, mime: up.mime, data: up.bytes, ownerId: p.userId });
    const old = t.protocol_file_id;
    ctx.store.touch('labTest', t);
    ctx.store.patch(t, { protocol_file_id: file.id, updated_at: ctx.store.nowIso() });
    softDeleteFile(ctx.store, old);
    return json(200, fileRef(ctx.cfg, file));
  },

  downloadLabProtocol(ctx) {
    const t = visibleTest(ctx, uuidParam(ctx.params.id));
    const f = liveFile(ctx.store, t.protocol_file_id);
    if (!f) throw notFound();
    return sendFile(ctx, f, 480, CACHE_PRIVATE, contentDisposition(f.original_name, f.mime));
  },
};
