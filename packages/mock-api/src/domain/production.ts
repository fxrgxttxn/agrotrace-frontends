import { sourcesOf } from './transitions.js';
import {
  addWorkingDays,
  canTransition,
  formatBatchCode,
  recallTaskDueAt,
  shouldCloseRecall,
  type BatchStatus,
} from '@agrotrace/domain';
import mercuryVsd from '@agrotrace/seed/data/vsd.json' with { type: 'json' };
import { shiftVsdDates, type Vsd } from '@agrotrace/seed/src/vsd.js';
import { compareCodePoints } from '@agrotrace/domain';
import { ApiError } from '../http/problem.js';
import { iso } from '../lib/time.js';
import type { Store } from '../store/store.js';
import type { BatchDocumentRow, BatchRow, LabTestRow, OrganizationRow, RecallRow, RecallTaskRow } from '../store/types.js';
import { notify } from './notify.js';
import { recalculateRating } from './rating.js';

export const LAB_OPEN: ReadonlySet<string> = new Set(sourcesOf('labTest', 'DONE'));
export const RECALL_REASON_LAB = 'Превышение нормативов по результатам лабораторного анализа';

export function transition(store: Store, b: BatchRow, to: BatchStatus, reason: string, byUserId: string | null): void {
  const from = b.status;
  if (!canTransition({ from, to }).allowed) throw new Error(`batch ${b.public_code}: ${from} → ${to} is not allowed`);
  store.touch('batch', b);
  const now = store.nowIso();
  store.patch(b, { status: to, version: b.version + 1, updated_at: now });
  store.insert('batch_status_history', { batch_id: b.id, from_status: from, to_status: to, changed_by: byUserId, reason, changed_at: now });
}

export function nextBatchCode(store: Store): string {
  store.markDirty();
  store.seq.batch += 1;
  return formatBatchCode({ year: new Date(store.now()).getUTCFullYear(), seq: store.seq.batch }).code;
}

export function insertBatch(store: Store, fields: Omit<BatchRow, 'id' | 'public_code' | 'status' | 'version' | 'created_at' | 'updated_at' | 'deleted_at' | 'qr_generated_at' | 'qr_png_file_id' | 'qr_pdf_file_id'>): BatchRow {
  const now = store.nowIso();
  const row: BatchRow = {
    id: store.id('batch'),
    public_code: nextBatchCode(store),
    status: 'Created',
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    qr_generated_at: null,
    qr_png_file_id: null,
    qr_pdf_file_id: null,
    ...fields,
  };
  store.insert('batches', row);
  store.created('batch', row);
  store.insert('batch_status_history', {
    batch_id: row.id,
    from_status: null,
    to_status: 'Created',
    changed_by: fields.created_by,
    reason: 'CREATED',
    changed_at: now,
  });
  return row;
}

export function chooseLab(store: Store, regionId: string | null): OrganizationRow | null {
  const labs = store.t.organizations.filter((o) => o.type === 'LAB' && o.status === 'ACTIVE' && o.deleted_at === null);
  if (labs.length === 0) return null;
  const local = labs.filter((l) => l.region_id === regionId);
  const pool = local.length ? local : labs;
  const load = (l: OrganizationRow): number =>
    store.t.lab_tests.filter((t) => t.lab_org_id === l.id && t.deleted_at === null && LAB_OPEN.has(t.status)).length;
  return [...pool].sort((a, b) => load(a) - load(b) || compareCodePoints(a.id, b.id))[0]!;
}

export function insertLabTest(store: Store, b: BatchRow, lab: OrganizationRow, reason: LabTestRow['reason'], createdBy: string | null): LabTestRow {
  const now = store.nowIso();
  const row: LabTestRow = {
    id: store.id('lab_test'),
    batch_id: b.id,
    lab_org_id: lab.id,
    reason,
    status: 'QUEUED',
    conclusion: null,
    sampled_at: null,
    completed_at: null,
    due_at: iso(addWorkingDays({ from: now, days: 5 }).result),
    escalated_at: null,
    protocol_file_id: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: createdBy,
    deleted_at: null,
    recall_id: null,
  };
  store.insert('lab_tests', row);
  store.created('labTest', row);
  notify(store, 'LAB_ASSIGNED', { orgs: [lab.id, b.origin_org_id] }, {
    labTestId: row.id,
    batchId: b.id,
    publicCode: b.public_code,
    productName: store.must('products', b.product_id).name,
    labOrgId: lab.id,
    labName: lab.name,
    reason,
    dueAt: row.due_at,
  });
  return row;
}

export function importVsd(store: Store, doc: BatchDocumentRow): void {
  const b = store.must('batches', doc.batch_id);
  const code = store.must('products', b.product_id).mercury_code;
  const inn = store.must('organizations', b.origin_org_id).inn;
  let found: Vsd | undefined;
  if (code && b.harvested_at) {
    const h = Date.parse(b.harvested_at);
    const from = iso(h - 3 * 86_400_000).slice(0, 10);
    const to = iso(h + 3 * 86_400_000).slice(0, 10);
    const desc = (x: string, y: string): number => (x < y ? 1 : x > y ? -1 : 0);
    found = shiftVsdDates(mercuryVsd as Vsd[], store.now())
      .filter((v) => v.product.code === code && v.consignor.inn === inn && v.issueDate >= from && v.issueDate <= to && v.status === 'CONFIRMED')
      .sort((x, y) => desc(x.issueDate, y.issueDate) || desc(x.number, y.number) || desc(x.uuid, y.uuid))[0];
  }
  const before = { importStatus: doc.import_status, attempts: doc.attempts };
  if (found)
    store.patch(doc, {
      import_status: 'IMPORTED',
      external_uuid: found.uuid,
      number: found.number,
      issue_date: found.issueDate,
      vsd_status: found.status,
      payload: found as unknown as Record<string, unknown>,
      attempts: 1,
      updated_at: store.nowIso(),
    });
  else store.patch(doc, { import_status: 'NOT_FOUND', attempts: code ? 1 : 0, updated_at: store.nowIso() });
  store.audit({
    action: 'system.vsdImport',
    actorId: null,
    entityType: 'batchDocument',
    entityId: doc.id,
    diff: { importStatus: [before.importStatus, doc.import_status], attempts: [before.attempts, doc.attempts] },
  });
}

export function traverse(store: Store, sourceId: string, direction: 'DOWN' | 'UP', maxDepth = 20): Map<string, number> {
  const found = new Map<string, number>();
  let frontier = [sourceId];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of store.t.batch_links) {
        const [from, to] = direction === 'DOWN' ? [l.parent_batch_id, l.child_batch_id] : [l.child_batch_id, l.parent_batch_id];
        if (from !== id || to === sourceId || found.has(to)) continue;
        found.set(to, depth);
        next.push(to);
      }
    }
    frontier = next;
  }
  return found;
}

export function runRecallEngine(
  store: Store,
  source: BatchRow,
  a: { trigger: RecallRow['trigger']; reason: string; blockUpstream: boolean; labTestId?: string; complaintId?: string; actorId: string },
): { recall: RecallRow; created: boolean } {
  const open = store.t.recalls.find((r) => r.source_batch_id === source.id && r.status === 'OPEN' && r.deleted_at === null);
  if (open) return { recall: open, created: false };
  const now = store.nowIso();
  const recall: RecallRow = {
    id: store.id('recall'),
    source_batch_id: source.id,
    trigger: a.trigger,
    reason: a.reason,
    status: 'OPEN',
    block_upstream: a.blockUpstream,
    lab_test_id: a.labTestId ?? null,
    complaint_id: a.complaintId ?? null,
    opened_at: now,
    closed_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: a.actorId,
    deleted_at: null,
  };
  store.insert('recalls', recall);
  const members: { batch: BatchRow; direction: 'SOURCE' | 'DOWN' | 'UP'; depth: number }[] = [
    { batch: source, direction: 'SOURCE', depth: 0 },
  ];
  for (const [id, depth] of traverse(store, source.id, 'DOWN')) members.push({ batch: store.must('batches', id), direction: 'DOWN', depth });
  if (a.blockUpstream)
    for (const [id, depth] of traverse(store, source.id, 'UP'))
      if (!members.some((x) => x.batch.id === id)) members.push({ batch: store.must('batches', id), direction: 'UP', depth });
  const tasks: RecallTaskRow[] = [];
  const dueAt = iso(recallTaskDueAt({ openedAt: now }).dueAt);
  for (const mb of members.filter((x) => x.batch.deleted_at === null).sort((x, y) => compareCodePoints(x.batch.id, y.batch.id))) {
    const before = mb.batch.status;
    store.insert('recall_batches', {
      id: store.id('recall_batch'),
      recall_id: recall.id,
      batch_id: mb.batch.id,
      direction: mb.direction,
      depth: mb.depth,
      status_before: before,
    });
    if (!canTransition({ from: before, to: 'Recalled' }).allowed) continue;
    transition(store, mb.batch, 'Recalled', 'RECALLED', a.actorId);
    let holder = mb.batch.holder_org_id;
    if (before === 'InTransit') {
      const sent = store.t.waybills.find(
        (w) => w.status === 'SENT' && w.deleted_at === null && store.t.waybill_items.some((i) => i.waybill_id === w.id && i.batch_id === mb.batch.id),
      );
      if (sent) holder = sent.receiver_org_id;
    }
    const task: RecallTaskRow = {
      id: store.id('recall_task'),
      recall_id: recall.id,
      holder_org_id: holder,
      batch_id: mb.batch.id,
      due_at: dueAt,
      status: 'OPEN',
      confirmed_by: null,
      confirmed_at: null,
      escalated_at: null,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    store.insert('recall_tasks', task);
    store.created('recallTask', task);
    tasks.push(task);
  }
  const eventPayload = { recallId: recall.id, sourceBatchId: source.id, publicCode: source.public_code, trigger: recall.trigger };
  const closed = shouldCloseRecall({ taskStatuses: tasks.map((t) => t.status) }).close;
  if (closed) {
    recall.status = 'CLOSED';
    recall.closed_at = now;
    recall.version = 2;
  }
  store.created('recall', recall);
  if (closed) notify(store, 'RECALL', { roles: ['INSPECTOR'] }, { ...eventPayload, event: 'CLOSED' });
  else
    notify(
      store,
      'RECALL',
      { roles: ['INSPECTOR'], orgs: [...new Set(tasks.map((t) => t.holder_org_id)), source.origin_org_id] },
      { ...eventPayload, event: 'OPENED' },
    );
  for (const task of tasks) {
    const b = store.must('batches', task.batch_id);
    notify(store, 'RECALL_TASK', { orgs: [task.holder_org_id] }, {
      recallId: recall.id,
      taskId: task.id,
      batchId: b.id,
      publicCode: b.public_code,
      dueAt: task.due_at,
      event: 'CREATED',
    });
  }
  recalculateRating(store, source.origin_org_id);
  return { recall, created: true };
}

export function ifMatch(request: Request): number {
  const raw = request.headers.get('If-Match');
  if (raw === null) throw new ApiError(400, 'VALIDATION', { errors: { 'If-Match': ['validation.required'] } });
  if (!/^[1-9]\d{0,9}$/.test(raw.trim())) throw new ApiError(400, 'VALIDATION', { errors: { 'If-Match': ['validation.type'] } });
  return Number(raw.trim());
}
