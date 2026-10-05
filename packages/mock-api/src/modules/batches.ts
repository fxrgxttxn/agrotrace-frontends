import { canBatchTransition, canEntityTransition } from '../domain/transitions.js';
import { requiresLabTest } from '@agrotrace/domain';
import { BatchCreateSchema, QrRequestSchema } from '@agrotrace/validation';
import { parseBody, WIRE_MASS } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { ApiError, forbidden, invalidTransition, notFound, validation, versionConflict } from '../http/problem.js';
import { fileRef, insertBytesFile, liveFile, signedUrl, softDeleteFile } from '../domain/files.js';
import { publicUrl, qrFiles } from '../domain/documents.js';
import { chooseLab, ifMatch, importVsd, insertBatch, insertLabTest, transition } from '../domain/production.js';
import { canSeeBatch, canSeeLabTest, seesAll, visibleBatchIds } from '../domain/visibility.js';
import { compareCodePoints } from '@agrotrace/domain';
import { contains, sortBy } from '../lib/sort.js';
import type { Ctx } from '../http/context.js';
import type { BatchRow, BatchStatus, Principal } from '../store/types.js';
import { batchListItem, orgRef, productRef, avatarUrl } from '../views/refs.js';
import { batchView, pathSteps, qrDenied } from '../views/batches.js';
import { CACHE_PRIVATE, sendFile } from './files.js';

const STATUSES: BatchStatus[] = ['Created', 'OnTest', 'Approved', 'InTransit', 'Accepted', 'Processed', 'OnSale', 'Sold', 'Blocked', 'Recalled', 'WrittenOff'];
const LIST_SORT = { fields: ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'], default: 'updatedAt,desc' };

export function visibleBatch(ctx: Ctx, id: string): BatchRow {
  const b = ctx.store.get('batches', id);
  if (!canSeeBatch(ctx.store, ctx.user(), b)) throw notFound();
  return b;
}

const isProducer = (p: Principal): boolean => p.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR' || r === 'RETAILER');

export const batchesHandlers: Record<string, Handler> = {
  listBatches(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page(LIST_SORT);
    const text = q.q();
    const statuses = q.enumList('status', STATUSES);
    const productId = q.uuid('productId');
    const holder = q.enumOf('holder', ['me', 'all'] as const);
    const origin = q.enumOf('origin', ['me', 'all'] as const);
    let orgId: string | undefined;
    if (seesAll(p)) orgId = q.uuid('orgId');
    else q.notAllowed('orgId');
    const kind = q.enumOf('kind', ['RAW', 'DERIVED'] as const);
    const range = q.dateRange();
    q.done();
    const visible = visibleBatchIds(ctx.store, p);
    const holds = isProducer(p);
    let rows = ctx.store.t.batches.filter((b) => visible.has(b.id));
    if (statuses) rows = rows.filter((b) => statuses.includes(b.status));
    if (productId) rows = rows.filter((b) => b.product_id === productId);
    if (holder === 'me') rows = rows.filter((b) => holds && b.holder_org_id === p.orgId);
    if (origin === 'me') rows = rows.filter((b) => holds && b.origin_org_id === p.orgId);
    if (orgId) rows = rows.filter((b) => b.origin_org_id === orgId || b.holder_org_id === orgId);
    if (kind) rows = rows.filter((b) => b.kind === kind);
    if (range.from || range.to) rows = rows.filter((b) => inDateRange(range, b.kind === 'RAW' ? b.harvested_at : b.produced_at));
    if (text !== undefined) rows = rows.filter((b) => contains(b.public_code, text));
    const keys = {
      publicCode: [(b: BatchRow) => b.public_code, 'text'],
      massKg: [(b: BatchRow) => b.mass_kg, 'decimal'],
      updatedAt: [(b: BatchRow) => b.updated_at, 'time'],
      harvestedAt: [(b: BatchRow) => b.harvested_at, 'time'],
      producedAt: [(b: BatchRow) => b.produced_at, 'time'],
    } as const;
    const [key, kindOf] = keys[sort.field as keyof typeof keys];
    const pg = paginate(sortBy(rows, key, kindOf, sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((b) => batchListItem(ctx, b)) });
  },

  async createBatch(ctx) {
    const p = ctx.user();
    const input = parseBody(BatchCreateSchema, await ctx.json(), (raw, add) => {
      if (typeof raw.massKg === 'string' && !WIRE_MASS.test(raw.massKg)) add('massKg', 'validation.mass.format');
    });
    const s = ctx.store;
    const errors: Record<string, string[]> = {};
    const field = s.get('fields', input.fieldId.toLowerCase());
    if (!field || field.deleted_at !== null || field.organization_id !== p.orgId) errors.fieldId = ['validation.notFound'];
    const product = s.get('products', input.productId.toLowerCase());
    if (!product || product.deleted_at !== null) errors.productId = ['validation.notFound'];
    else if (product.category === 'PROCESSED') errors.productId = ['validation.product.category'];
    if (Date.parse(input.harvestedAt) > s.now()) errors.harvestedAt = ['validation.date.future'];
    if (Object.keys(errors).length > 0) throw validation(errors);
    const farmBatchCount = s.t.batches.filter((b) => b.origin_org_id === p.orgId && b.kind === 'RAW' && b.deleted_at === null).length;
    const b = insertBatch(s, {
      product_id: product!.id,
      origin_org_id: p.orgId,
      holder_org_id: p.orgId,
      field_id: field!.id,
      kind: 'RAW',
      mass_kg: input.massKg,
      harvested_at: new Date(input.harvestedAt).toISOString(),
      produced_at: null,
      test_required: false,
      test_reason: 'NONE',
      created_by: p.userId,
    });
    const since = s.now() - 30 * 86_400_000;
    const pesticides = s.t.treatments.filter((t) => {
      const sub = s.must('substances', t.substance_id);
      const at = Date.parse(t.applied_at);
      return t.field_id === field!.id && t.deleted_at === null && sub.type === 'PESTICIDE' && at >= since && at <= s.now();
    }).length;
    const org = s.must('organizations', p.orgId);
    const risk = requiresLabTest({
      publicCode: b.public_code,
      farmBatchCount,
      trustRating: org.trust_rating ?? 0,
      pesticideTreatmentsLast30Days: pesticides,
    });
    s.patch(b, { test_required: risk.required, test_reason: risk.reason });
    if (!risk.required) transition(s, b, 'Approved', 'TEST_NOT_REQUIRED', null);
    else {
      const lab = chooseLab(s, field!.region_id);
      if (!lab) throw new ApiError(409, 'NO_LAB_AVAILABLE');
      insertLabTest(s, b, lab, risk.reason === 'SAMPLED' ? 'PLANNED' : 'RISK', null);
      transition(s, b, 'OnTest', 'TEST_REQUIRED', null);
    }
    if (product!.category === 'DAIRY' || product!.category === 'MEAT') {
      const now = s.nowIso();
      const doc = s.insert('batch_documents', {
        id: s.id('batch_document'),
        batch_id: b.id,
        kind: 'VSD',
        external_uuid: null,
        number: null,
        issue_date: null,
        vsd_status: null,
        import_status: 'PENDING',
        payload: null,
        attempts: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      });
      s.created('batchDocument', doc);
      s.afterCommit(() => importVsd(s, doc));
    }
    return json(201, batchView(ctx, p, b));
  },

  getBatch(ctx) {
    const b = visibleBatch(ctx, uuidParam(ctx.params.id));
    return json(200, batchView(ctx, ctx.user(), b));
  },

  getBatchGraph(ctx) {
    const id = uuidParam(ctx.params.id);
    const raw = ctx.url.searchParams.getAll('depth');
    let depth = 2;
    if (raw.length > 0) {
      if (raw.length > 1 || !/^\d+$/.test(raw[0]!) || Number(raw[0]) < 1 || Number(raw[0]) > 5)
        throw validation({ depth: ['validation.range'] });
      depth = Number(raw[0]);
    }
    const root = visibleBatch(ctx, id);
    const s = ctx.store;
    const visible = visibleBatchIds(s, ctx.user());
    const nodes = new Map<string, number>([[root.id, 0]]);
    for (const dir of ['UP', 'DOWN'] as const) {
      let frontier = [root.id];
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        for (const nid of frontier)
          for (const l of s.t.batch_links) {
            const [from, to] = dir === 'DOWN' ? [l.parent_batch_id, l.child_batch_id] : [l.child_batch_id, l.parent_batch_id];
            if (from !== nid || nodes.has(to) || s.get('batches', to)?.deleted_at) continue;
            nodes.set(to, dir === 'UP' ? -d : d);
            next.push(to);
          }
        frontier = next;
      }
    }
    const list = [...nodes].map(([nid, d]) => ({ b: s.must('batches', nid), d }));
    list.sort((x, y) => x.d - y.d || compareCodePoints(x.b.public_code, y.b.public_code));
    const code = (bid: string): string => s.must('batches', bid).public_code;
    const edges = s.t.batch_links
      .filter((l) => nodes.has(l.parent_batch_id) && nodes.has(l.child_batch_id))
      .sort((x, y) => compareCodePoints(code(x.parent_batch_id), code(y.parent_batch_id)) || compareCodePoints(code(x.child_batch_id), code(y.child_batch_id)))
      .map((l) => ({ parent: l.parent_batch_id, child: l.child_batch_id, massUsedKg: l.mass_used_kg }));
    return json(200, {
      rootId: root.id,
      depth,
      nodes: list.map(({ b, d }) => ({
        id: b.id,
        publicCode: b.public_code,
        product: productRef(ctx, b.product_id),
        status: b.status,
        holder: orgRef(ctx, b.holder_org_id),
        depth: d,
        accessible: visible.has(b.id),
      })),
      edges,
    });
  },

  getBatchHistory(ctx) {
    const b = visibleBatch(ctx, uuidParam(ctx.params.id));
    const rows = ctx.store.t.batch_status_history
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.batch_id === b.id)
      .sort((x, y) => Date.parse(x.h.changed_at) - Date.parse(y.h.changed_at) || x.i - y.i);
    return json(
      200,
      rows.map(({ h }) => {
        const u = h.changed_by ? ctx.store.get('users', h.changed_by) : undefined;
        return {
          from: h.from_status,
          to: h.to_status,
          changedAt: h.changed_at,
          reason: h.reason,
          changedBy: u ? { fullName: u.full_name, avatarUrl: avatarUrl(ctx, u.avatar_file_id) } : null,
        };
      }),
    );
  },

  getBatchPath(ctx) {
    const b = visibleBatch(ctx, uuidParam(ctx.params.id));
    return json(200, pathSteps(ctx, b));
  },

  async createBatchQr(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const body = await ctx.json(true);
    if (body !== undefined) parseBody(QrRequestSchema, body);
    const b = visibleBatch(ctx, id);
    const denied = qrDenied(ctx, p, b);
    if (denied) throw forbidden(denied, denied.reason === 'NOT_HOLDER' ? 'Not the batch holder' : 'Batch status does not allow QR');
    const { png, pdf } = await qrFiles(ctx.cfg, ctx.store, b);
    const pngFile = insertBytesFile(ctx.store, { kind: 'QR', originalName: `${b.public_code}.png`, mime: 'image/png', data: png, ownerId: p.userId });
    const pdfFile = insertBytesFile(ctx.store, { kind: 'QR', originalName: `${b.public_code}.pdf`, mime: 'application/pdf', data: pdf, ownerId: p.userId });
    pngFile.regen = { type: 'qrPng', batchId: b.id };
    pdfFile.regen = { type: 'qrPdf', batchId: b.id };
    const [oldPng, oldPdf] = [b.qr_png_file_id, b.qr_pdf_file_id];
    ctx.store.touch('batch', b);
    ctx.store.patch(b, { qr_png_file_id: pngFile.id, qr_pdf_file_id: pdfFile.id, qr_generated_at: ctx.store.nowIso() });
    softDeleteFile(ctx.store, oldPng);
    softDeleteFile(ctx.store, oldPdf);
    return json(201, { publicUrl: publicUrl(ctx.cfg, b.public_code), pngUrl: signedUrl(ctx.cfg, pngFile.id), pdfUrl: signedUrl(ctx.cfg, pdfFile.id) });
  },

  downloadBatchQr(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    const format = q.enumOf('format', ['png', 'pdf'] as const);
    if (!q.has('format')) q.errors.format = ['validation.required'];
    q.done();
    const b = visibleBatch(ctx, id);
    const denied = qrDenied(ctx, p, b);
    if (denied) throw forbidden(denied, denied.reason === 'NOT_HOLDER' ? 'Not the batch holder' : 'Batch status does not allow QR');
    const f = liveFile(ctx.store, format === 'png' ? b.qr_png_file_id : b.qr_pdf_file_id);
    if (!f) throw notFound('QR not generated');
    return sendFile(ctx, f, 480, CACHE_PRIVATE, `inline; filename="${b.public_code}.${format}"`);
  },

  getBatchDocuments(ctx) {
    const p = ctx.user();
    const b = visibleBatch(ctx, uuidParam(ctx.params.id));
    const s = ctx.store;
    const vsdRow = s.t.batch_documents.find((d) => d.batch_id === b.id && d.kind === 'VSD');
    const payload = vsdRow?.payload as
      | { product?: { name?: string }; volume?: { value: number; unit: string }; consignor?: { inn: string; name: string }; consignee?: { inn: string; name: string } }
      | null
      | undefined;
    const vsd = vsdRow
      ? {
          id: vsdRow.id,
          importStatus: vsdRow.import_status,
          document:
            vsdRow.import_status === 'IMPORTED' && payload
              ? {
                  externalUuid: vsdRow.external_uuid,
                  number: vsdRow.number,
                  issueDate: vsdRow.issue_date,
                  status: vsdRow.vsd_status,
                  productName: payload.product?.name ?? '',
                  volume: payload.volume ?? { value: 0, unit: '' },
                  consignor: { inn: payload.consignor?.inn ?? '', name: payload.consignor?.name ?? '' },
                  consignee: { inn: payload.consignee?.inn ?? '', name: payload.consignee?.name ?? '' },
                }
              : null,
          attempts: vsdRow.attempts,
          requestedAt: vsdRow.created_at,
          updatedAt: vsdRow.updated_at,
        }
      : null;
    const batches = visibleBatchIds(s, p);
    const labProtocols = s.t.lab_tests
      .filter((t) => t.batch_id === b.id && t.deleted_at === null && liveFile(s, t.protocol_file_id) && canSeeLabTest(s, p, t, batches))
      .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at) || compareCodePoints(x.id, y.id))
      .map((t) => ({
        labTestId: t.id,
        lab: orgRef(ctx, t.lab_org_id),
        reason: t.reason,
        conclusion: t.conclusion,
        completedAt: t.completed_at,
        file: fileRef(ctx.cfg, liveFile(s, t.protocol_file_id)!),
      }));
    const canQr = p.roles.some((r) => r === 'PROCESSOR' || r === 'RETAILER') && !qrDenied(ctx, p, b);
    const png = liveFile(s, b.qr_png_file_id);
    const pdf = liveFile(s, b.qr_pdf_file_id);
    const qr = canQr && png && pdf ? { publicUrl: publicUrl(ctx.cfg, b.public_code), pngUrl: signedUrl(ctx.cfg, png.id), pdfUrl: signedUrl(ctx.cfg, pdf.id) } : null;
    return json(200, { batchId: b.id, vsd, labProtocols, qr });
  },

  retryBatchVsdImport(ctx) {
    const p = ctx.user();
    const b = visibleBatch(ctx, uuidParam(ctx.params.id));
    if (b.holder_org_id !== p.orgId) throw forbidden({ reason: 'NOT_HOLDER' }, 'Not the batch holder');
    const doc = ctx.store.t.batch_documents.find((d) => d.batch_id === b.id && d.kind === 'VSD');
    if (!doc) throw notFound();
    if (!canEntityTransition('vsdImport', doc.import_status, 'PENDING', 'retryBatchVsdImport'))
      throw invalidTransition({ from: doc.import_status, to: 'PENDING' });
    ctx.store.touch('batchDocument', doc);
    ctx.store.patch(doc, { import_status: 'PENDING', attempts: 0, last_error: null, updated_at: ctx.store.nowIso() });
    const response = json(202, {
      id: doc.id,
      importStatus: 'PENDING',
      document: null,
      attempts: 0,
      requestedAt: doc.created_at,
      updatedAt: doc.updated_at,
    });
    ctx.store.afterCommit(() => importVsd(ctx.store, doc));
    return response;
  },

  putBatchOnSale: (ctx) => saleTransition(ctx, 'OnSale', 'ON_SALE'),
  markBatchSold: (ctx) => saleTransition(ctx, 'Sold', 'SOLD'),
};

function saleTransition(ctx: Ctx, to: BatchStatus, reason: string): Response {
  const p = ctx.user();
  const id = uuidParam(ctx.params.id);
  const version = ifMatch(ctx.request);
  const b = visibleBatch(ctx, id);
  if (b.holder_org_id !== p.orgId) throw forbidden({ reason: 'NOT_HOLDER' }, 'Not the batch holder');
  if (b.version !== version) throw versionConflict(b.version);
  if (!canBatchTransition(b.status, to)) throw invalidTransition({ from: b.status, to });
  transition(ctx.store, b, to, reason, p.userId);
  return json(200, batchView(ctx, p, b));
}
