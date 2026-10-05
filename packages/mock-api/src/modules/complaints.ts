import { canEntityTransition } from '../domain/transitions.js';
import { ComplaintDecisionSchema, ComplaintReviewRequestSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, type Ctx, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { ApiError, invalidTransition, notFound, validation } from '../http/problem.js';
import { insertLabTest, runRecallEngine } from '../domain/production.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { ComplaintRow } from '../store/types.js';
import { actorRef, batchListItem } from '../views/refs.js';

const STATUSES = ['NEW', 'IN_REVIEW', 'DECIDED'] as const;
const DECISIONS = ['REJECT', 'LAB_TEST', 'RECALL'] as const;

const listItem = (m: Mock, c: ComplaintRow) => ({
  id: c.id,
  batch: batchListItem(m, m.store.must('batches', c.batch_id)),
  text: c.text,
  status: c.status,
  decision: c.decision,
  createdAt: c.created_at,
  decidedAt: c.decided_at,
});

export const complaintView = (m: Mock, c: ComplaintRow) => ({
  ...listItem(m, c),
  contact: c.contact,
  decisionComment: c.decision_comment,
  inspector: actorRef(m, c.inspector_id),
  labTestId: c.lab_test_id,
  recallId: c.recall_id,
});

function liveComplaint(ctx: Ctx, id: string): ComplaintRow {
  const c = ctx.store.get('complaints', id);
  if (!c || c.deleted_at !== null) throw notFound();
  return c;
}

export const complaintsHandlers: Record<string, Handler> = {
  listComplaints(ctx) {
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['createdAt', 'decidedAt'], default: 'createdAt,desc' });
    const text = q.q();
    const statuses = q.enumList('status', STATUSES);
    const decisions = q.enumList('decision', DECISIONS);
    const batchId = q.uuid('batchId');
    const range = q.dateRange();
    q.done();
    let rows = ctx.store.t.complaints.filter((c) => c.deleted_at === null);
    if (statuses) rows = rows.filter((c) => statuses.includes(c.status));
    if (decisions) rows = rows.filter((c) => c.decision !== null && decisions.includes(c.decision));
    if (batchId) rows = rows.filter((c) => c.batch_id === batchId);
    if (range.from || range.to) rows = rows.filter((c) => inDateRange(range, c.created_at));
    if (text !== undefined)
      rows = rows.filter((c) => contains(ctx.store.must('batches', c.batch_id).public_code, text) || contains(c.text, text));
    const key = sort.field === 'decidedAt' ? (c: ComplaintRow) => c.decided_at : (c: ComplaintRow) => c.created_at;
    const pg = paginate(sortBy(rows, key, 'time', sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((c) => listItem(ctx, c)) });
  },

  getComplaint: (ctx) => json(200, complaintView(ctx, liveComplaint(ctx, uuidParam(ctx.params.id)))),

  async startComplaintReview(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const body = await ctx.json(true);
    if (body !== undefined) parseBody(ComplaintReviewRequestSchema, body);
    const c = liveComplaint(ctx, id);
    if (!canEntityTransition('complaint', c.status, 'IN_REVIEW')) throw invalidTransition({ from: c.status, to: 'IN_REVIEW' });
    ctx.store.touch('complaint', c);
    ctx.store.patch(c, { status: 'IN_REVIEW', inspector_id: p.userId, updated_at: ctx.store.nowIso() });
    return json(200, complaintView(ctx, c));
  },

  async decideComplaint(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const raw = await ctx.json();
    const pre: Record<string, string[]> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if ('labOrgId' in r && r.decision !== 'LAB_TEST' && typeof r.decision === 'string') pre.labOrgId = ['validation.notAllowed'];
      if ('blockUpstream' in r && r.decision !== 'RECALL' && typeof r.decision === 'string') pre.blockUpstream = ['validation.notAllowed'];
      if (r.decision === 'LAB_TEST' && !('labOrgId' in r)) pre.labOrgId = ['validation.required'];
    }
    let input;
    try {
      input = parseBody(ComplaintDecisionSchema, raw);
    } catch (e) {
      if (e instanceof ApiError && e.extras.errors) throw validation({ ...e.extras.errors, ...pre });
      throw e;
    }
    if (Object.keys(pre).length > 0) throw validation(pre);
    const s = ctx.store;
    const c = liveComplaint(ctx, id);
    if (!canEntityTransition('complaint', c.status, 'DECIDED')) throw invalidTransition({ from: c.status, to: 'DECIDED' });
    let lab;
    if (input.decision === 'LAB_TEST') {
      lab = s.get('organizations', input.labOrgId.toLowerCase());
      if (!lab || lab.status !== 'ACTIVE' || lab.deleted_at !== null) throw validation({ labOrgId: ['validation.notFound'] });
      if (lab.type !== 'LAB') throw validation({ labOrgId: ['validation.labOrg.type'] });
    }
    const now = s.nowIso();
    s.touch('complaint', c);
    s.patch(c, { status: 'DECIDED', decision: input.decision, decision_comment: input.comment, inspector_id: p.userId, decided_at: now, updated_at: now });
    const b = s.must('batches', c.batch_id);
    if (input.decision === 'LAB_TEST') s.patch(c, { lab_test_id: insertLabTest(s, b, lab!, 'COMPLAINT', p.userId).id });
    if (input.decision === 'RECALL') {
      const { recall } = runRecallEngine(s, b, {
        trigger: 'COMPLAINT',
        reason: input.comment,
        blockUpstream: input.blockUpstream ?? false,
        complaintId: c.id,
        actorId: p.userId,
      });
      s.patch(c, { recall_id: recall.id });
    }
    return json(200, complaintView(ctx, c));
  },
};
