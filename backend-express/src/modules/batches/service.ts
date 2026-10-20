/**
 * Batches (contracts/openapi/paths/batches.yaml; FR-PROD-03, FR-PROD-07, FR-PROD-08, R20, R42–R45, R49, R81):
 * list, registration with the BR-03 risk model and lab assignment (D18), card, history, path, graph, sale.
 * QR and documents live in qr.ts and ../documents/service.ts. Visibility — visibility.ts.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import {
  addWorkingDays,
  BATCH_STATUSES,
  compareCodePoints,
  requiresLabTest,
  type BatchStatus,
} from '@agrotrace/domain';
import { BatchCreateSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { lockBatches } from '../../db/locks.js';
import { withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { checkVersion } from '../../http/if-match.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { enqueue } from '../../infra/outbox.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { dropPublicPages } from '../public/cache.js';
import { canBatchGo, notify, transitionBatch } from './lifecycle.js';
import { iso, loadCard, loadListItems, type BatchCard } from './view.js';
import { batchVisibleTo, isParticipant, seesAll } from './visibility.js';
import { pathStages } from './path.js';

type Q = Kysely<DB> | Transaction<DB>;

const LIST_SORT = {
  fields: ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'],
  default: 'updatedAt,desc',
} as const;
const DAY_MS = 86_400_000;
/** Lab tests that count as a laboratory's load (D18). */
const LAB_LOAD_STATUSES = ['QUEUED', 'SAMPLED', 'ESCALATED'];

const forbidden = (params: Record<string, unknown>, title: string) =>
  new AppProblem(403, 'FORBIDDEN', { params, title });
export const notHolder = (publicCode?: string) =>
  forbidden(
    { reason: 'NOT_HOLDER', ...(publicCode !== undefined && { publicCode }) },
    'Not the batch holder',
  );
export const invalidTransition = (params: Record<string, unknown>) =>
  new AppProblem(409, 'INVALID_TRANSITION', { params });

/** Audit view of a batch row (API names and formats). */
export function batchAudit(b: {
  public_code: string;
  product_id: string;
  origin_org_id: string;
  holder_org_id: string | null;
  field_id: string | null;
  kind: string;
  mass_kg: string;
  harvested_at: unknown;
  produced_at: unknown;
  status: string;
  test_required: boolean;
  test_reason: string;
  version: number;
}) {
  return {
    publicCode: b.public_code,
    productId: b.product_id,
    originOrgId: b.origin_org_id,
    holderOrgId: b.holder_org_id,
    fieldId: b.field_id,
    kind: b.kind,
    massKg: b.mass_kg,
    harvestedAt: b.harvested_at ? iso(b.harvested_at) : null,
    producedAt: b.produced_at ? iso(b.produced_at) : null,
    status: b.status,
    testRequired: b.test_required,
    testReason: b.test_reason,
    version: b.version,
  };
}

export function batchesService(c: Container) {
  const { db } = c;

  /** The non-deleted batch `id` if `p` sees it, else 404. `lock` — `FOR UPDATE` first (checks on the locked row). */
  async function visibleBatch(q: Q, p: Principal, id: string, lock = false) {
    let query = q
      .selectFrom('batches as b')
      .selectAll('b')
      .select(batchVisibleTo(p, sql.ref('b.id')).as('visible'))
      .where('b.id', '=', id)
      .where('b.deleted_at', 'is', null);
    if (lock) query = query.forUpdate('b');
    const b = await query.executeTakeFirst();
    if (!b || !b.visible) throw new AppProblem(404, 'NOT_FOUND');
    return b;
  }

  /** The least-loaded ACTIVE laboratory, the field's region first, ties by id as text (code points); null — none. */
  async function chooseLab(tx: Transaction<DB>, regionId: string) {
    const labs = await tx
      .selectFrom('organizations as o')
      .select([
        'o.id',
        'o.name',
        'o.region_id',
        sql<string>`(SELECT count(*) FROM lab_tests t WHERE t.lab_org_id = o.id AND t.deleted_at IS NULL
          AND t.status IN (${sql.join(LAB_LOAD_STATUSES)}))`.as('load'),
      ])
      .where('o.type', '=', 'LAB')
      .where('o.status', '=', 'ACTIVE')
      .where('o.deleted_at', 'is', null)
      .execute();
    if (labs.length === 0) return null;
    const local = labs.filter((l) => l.region_id === regionId);
    const pool = local.length > 0 ? local : labs;
    return [...pool].sort((a, b) => Number(a.load) - Number(b.load) || compareCodePoints(a.id, b.id))[0]!;
  }

  /** putBatchOnSale / markBatchSold: lock → 404 → 403 NOT_HOLDER → If-Match → transition (R20). */
  async function sale(p: Principal, id: string, version: number, to: 'OnSale' | 'Sold', operationId: string) {
    const code = await withTx(
      db,
      async (tx) => {
        const b = await visibleBatch(tx, p, id, true);
        if (b.holder_org_id !== p.orgId) throw notHolder();
        checkVersion(version, b.version);
        if (!canBatchGo(b.status, to)) throw invalidTransition({ from: b.status, to });
        const v = await transitionBatch(tx, b, to, to === 'OnSale' ? 'ON_SALE' : 'SOLD', p.userId);
        await auditService.record(tx, {
          actorId: p.userId,
          action: operationId,
          entityType: 'batch',
          entityId: id,
          diff: { status: [b.status, to], version: [b.version, v] },
        });
        return b.public_code;
      },
      { conflictParams: () => currentVersion(id) },
    );
    await dropPublicPages(c.redis, [code]);
    return loadCard(db, p, id);
  }

  async function currentVersion(id: string) {
    const r = await db.selectFrom('batches').select('version').where('id', '=', id).executeTakeFirst();
    return r ? { currentVersion: r.version } : undefined;
  }

  return {
    visibleBatch,

    /** listBatches — visible batches, filters joined by AND (R49, R51), `x-sort`. */
    async list(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
      const statuses = q.enumList('status', BATCH_STATUSES);
      const productId = q.uuid('productId');
      const holder = q.enumOf('holder', ['me', 'all'] as const);
      const origin = q.enumOf('origin', ['me', 'all'] as const);
      let orgId: string | undefined;
      if (seesAll(p)) orgId = q.uuid('orgId');
      else q.notAllowed('orgId');
      const kind = q.enumOf('kind', ['RAW', 'DERIVED'] as const);
      const { from, to } = q.dateRange();
      q.done();

      const produced = sql`CASE WHEN b.kind = 'RAW' THEN b.harvested_at ELSE b.produced_at END`;
      let base = db
        .selectFrom('batches as b')
        .where('b.deleted_at', 'is', null)
        .where(batchVisibleTo(p, sql.ref('b.id')));
      if (statuses) base = base.where('b.status', 'in', statuses);
      if (productId) base = base.where('b.product_id', '=', productId);
      const participant = isParticipant(p);
      if (holder === 'me')
        base = participant ? base.where('b.holder_org_id', '=', p.orgId) : base.where(sql<boolean>`false`);
      if (origin === 'me')
        base = participant ? base.where('b.origin_org_id', '=', p.orgId) : base.where(sql<boolean>`false`);
      if (orgId)
        base = base.where((eb) =>
          eb.or([eb('b.origin_org_id', '=', orgId), eb('b.holder_org_id', '=', orgId)]),
        );
      if (kind) base = base.where('b.kind', '=', kind);
      if (from) base = base.where(sql<boolean>`${produced} >= ${new Date(`${from}T00:00:00Z`)}`);
      if (to) base = base.where(sql<boolean>`${produced} < ${dayAfter(to)}`);
      if (text !== undefined)
        base = base.where(sql<boolean>`position(lower(${text}) in lower(b.public_code)) > 0`);
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = {
        publicCode: sql`b.public_code COLLATE "C"`,
        massKg: sql`b.mass_kg`,
        updatedAt: sql`b.updated_at`,
        harvestedAt: sql`b.harvested_at`,
        producedAt: sql`b.produced_at`,
      }[sort.field as (typeof LIST_SORT.fields)[number]];
      const rows = await base
        .select('b.id')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC NULLS LAST` : sql`${order} DESC NULLS LAST`)
        .orderBy(sql`b.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadListItems(
          db,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    /**
     * createBatch — one transaction: insert (Created, CREATED by the user) → BR-03 → Approved (TEST_NOT_REQUIRED) or a
     * lab test + OnTest (TEST_REQUIRED) + LAB_ASSIGNED; no ACTIVE lab → 409 NO_LAB_AVAILABLE, everything rolled back
     * (the code sequence value is spent); DAIRY/MEAT → a PENDING VSD row + `vsd.import` (R81).
     */
    async create(p: Principal, body: unknown): Promise<BatchCard> {
      const input = parseBody(BatchCreateSchema, body, ['massKg']);
      const fieldId = input.fieldId.toLowerCase();
      const productId = input.productId.toLowerCase();
      const { id, events } = await withTx(db, async (tx) => {
        const errors: Record<string, string[]> = {};
        const field = await tx
          .selectFrom('fields')
          .select(['id', 'region_id'])
          .where('id', '=', fieldId)
          .where('organization_id', '=', p.orgId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!field) errors.fieldId = ['validation.notFound'];
        const product = await tx
          .selectFrom('products')
          .select(['id', 'name', 'category'])
          .where('id', '=', productId)
          .where('deleted_at', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (!product) errors.productId = ['validation.notFound'];
        else if (product.category === 'PROCESSED') errors.productId = ['validation.product.category'];
        const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
        if (Date.parse(input.harvestedAt) > Date.now()) errors.harvestedAt = ['validation.date.future'];
        if (Object.keys(errors).length > 0) throw validationProblem(errors);

        const b = await tx
          .insertInto('batches')
          .values({
            public_code: sql<string>`next_batch_code()`,
            product_id: product!.id,
            origin_org_id: p.orgId,
            holder_org_id: p.orgId,
            field_id: field!.id,
            kind: 'RAW',
            mass_kg: input.massKg,
            harvested_at: input.harvestedAt,
            status: 'Created',
            version: 1,
            created_by: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('batch_status_history')
          .values({
            batch_id: b.id,
            from_status: null,
            to_status: 'Created',
            changed_by: p.userId,
            reason: 'CREATED',
            changed_at: sql`now()`,
          })
          .execute();

        // BR-03 inputs (contract createBatch step 3).
        const [{ count: farmBatchCount }] = (await tx
          .selectFrom('batches')
          .select(sql<string>`count(*)`.as('count'))
          .where('origin_org_id', '=', p.orgId)
          .where('kind', '=', 'RAW')
          .where('deleted_at', 'is', null)
          .where('id', '<>', b.id)
          .execute()) as [{ count: string }];
        const org = await tx
          .selectFrom('organizations')
          .select(['trust_rating'])
          .where('id', '=', p.orgId)
          .executeTakeFirstOrThrow();
        const [{ count: pesticides }] = (await tx
          .selectFrom('treatments as t')
          .innerJoin('substances as s', 's.id', 't.substance_id')
          .select(sql<string>`count(*)`.as('count'))
          .where('t.field_id', '=', field!.id)
          .where('t.deleted_at', 'is', null)
          .where('s.type', '=', 'PESTICIDE')
          .where('t.applied_at', '>=', new Date(now.getTime() - 30 * DAY_MS))
          .where('t.applied_at', '<=', now)
          .execute()) as [{ count: string }];
        const risk = requiresLabTest({
          publicCode: b.public_code,
          farmBatchCount: Number(farmBatchCount),
          trustRating: org.trust_rating ?? 0,
          pesticideTreatmentsLast30Days: Number(pesticides),
        });
        await tx
          .updateTable('batches')
          .set({ test_required: risk.required, test_reason: risk.reason })
          .where('id', '=', b.id)
          .execute();

        let version: number;
        let status: BatchStatus;
        const events: string[] = [];
        if (!risk.required) {
          version = await transitionBatch(tx, b, 'Approved', 'TEST_NOT_REQUIRED', null);
          status = 'Approved';
        } else {
          const lab = await chooseLab(tx, field!.region_id);
          if (!lab) throw new AppProblem(409, 'NO_LAB_AVAILABLE');
          const reason = risk.reason === 'SAMPLED' ? 'PLANNED' : 'RISK';
          const dueAt = addWorkingDays({ from: now.toISOString(), days: 5 }).result;
          const t = await tx
            .insertInto('lab_tests')
            .values({
              batch_id: b.id,
              lab_org_id: lab.id,
              reason,
              status: 'QUEUED',
              due_at: dueAt,
              created_at: now,
              created_by: null,
            })
            .returning(['id'])
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'createBatch',
            entityType: 'labTest',
            entityId: t.id,
            diff: auditDiff(null, {
              batchId: b.id,
              labOrgId: lab.id,
              reason,
              status: 'QUEUED',
              dueAt: new Date(dueAt).toISOString(),
              version: 1,
            }),
          });
          version = await transitionBatch(tx, b, 'OnTest', 'TEST_REQUIRED', null);
          status = 'OnTest';
          await notify(
            tx,
            'LAB_ASSIGNED',
            { orgIds: [lab.id, p.orgId] },
            {
              labTestId: t.id,
              batchId: b.id,
              publicCode: b.public_code,
              productName: product!.name,
              labOrgId: lab.id,
              labName: lab.name,
              reason,
              dueAt: new Date(dueAt).toISOString(),
            },
          );
        }
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createBatch',
          entityType: 'batch',
          entityId: b.id,
          diff: auditDiff(
            null,
            batchAudit({ ...b, status, version, test_required: risk.required, test_reason: risk.reason }),
          ),
        });

        if (product!.category === 'DAIRY' || product!.category === 'MEAT') {
          const doc = await tx
            .insertInto('batch_documents')
            .values({ batch_id: b.id, kind: 'VSD', import_status: 'PENDING', attempts: 0 })
            .returning(['id'])
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'createBatch',
            entityType: 'batchDocument',
            entityId: doc.id,
            diff: auditDiff(null, { batchId: b.id, kind: 'VSD', importStatus: 'PENDING', attempts: 0 }),
          });
          const ev = await enqueue(tx, {
            type: 'vsd.import',
            payload: { documentId: doc.id, batchId: b.id, publicCode: b.public_code },
          });
          events.push(ev.id);
        }
        return { id: b.id, events };
      });
      await c.relay.publish(events);
      return loadCard(db, p, id);
    },

    async get(p: Principal, id: string): Promise<BatchCard> {
      await visibleBatch(db, p, id);
      return loadCard(db, p, id);
    },

    /** getBatchHistory — every row by changed_at, then insertion order. */
    async history(p: Principal, id: string) {
      await visibleBatch(db, p, id);
      const rows = await db
        .selectFrom('batch_status_history as h')
        .leftJoin('users as u', 'u.id', 'h.changed_by')
        .select([
          'h.from_status',
          'h.to_status',
          'h.changed_at',
          'h.reason',
          'h.changed_by',
          'u.full_name',
          'u.avatar_file_id',
        ])
        .where('h.batch_id', '=', id)
        .orderBy('h.changed_at')
        .orderBy('h.id')
        .execute();
      return rows.map((h) => ({
        from: h.from_status,
        to: h.to_status,
        changedAt: iso(h.changed_at),
        reason: h.reason,
        changedBy:
          h.changed_by && h.full_name !== null
            ? {
                fullName: h.full_name,
                avatarUrl: h.avatar_file_id ? c.fileUrls.signed(h.avatar_file_id) : null,
              }
            : null,
      }));
    },

    /**
     * getBatchPath (R45): the origin from harvestedAt/producedAt; every ACCEPTED waybill with the batch (by
     * acceptedAt) closes the previous stage and opens the receiver's.
     */
    async path(p: Principal, id: string) {
      const b = await visibleBatch(db, p, id);
      return pathStages(db, b);
    },

    /**
     * getBatchGraph (FR-PROD-07): parents (depth < 0) and children (depth > 0) up to `depth` levels each way, every
     * node once at its smallest |depth|, no siblings; nodes outside the caller's visibility `accessible: false`;
     * edges = links between included nodes. Order: nodes by depth, publicCode; edges by parent then child publicCode.
     */
    async graph(p: Principal, id: string, query: Request['query']) {
      const raw = query.depth;
      let depth = 2;
      if (raw !== undefined) {
        if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 5)
          throw validationProblem({ depth: ['validation.range'] });
        depth = Number(raw);
      }
      const root = await visibleBatch(db, p, id);
      const nodes = new Map<string, number>([[root.id, 0]]);
      for (const dir of ['UP', 'DOWN'] as const) {
        let frontier = [root.id];
        for (let d = 1; d <= depth && frontier.length > 0; d++) {
          const links = await db
            .selectFrom('batch_links as l')
            .innerJoin('batches as b', 'b.id', dir === 'DOWN' ? 'l.child_batch_id' : 'l.parent_batch_id')
            .select(['b.id'])
            .where(dir === 'DOWN' ? 'l.parent_batch_id' : 'l.child_batch_id', 'in', frontier)
            .where('b.deleted_at', 'is', null)
            .execute();
          const next: string[] = [];
          for (const l of links) {
            if (nodes.has(l.id)) continue;
            nodes.set(l.id, dir === 'UP' ? -d : d);
            next.push(l.id);
          }
          frontier = next;
        }
      }
      const ids = [...nodes.keys()];
      const rows = await db
        .selectFrom('batches as b')
        .select(['b.id', batchVisibleTo(p, sql.ref('b.id')).as('visible')])
        .where('b.id', 'in', ids)
        .execute();
      const visible = new Map(rows.map((r) => [r.id, r.visible]));
      const items = new Map((await loadListItems(db, ids)).map((x) => [x.id, x]));
      const list = ids
        .map((nid) => ({ item: items.get(nid)!, depth: nodes.get(nid)! }))
        .sort((x, y) => x.depth - y.depth || compareCodePoints(x.item.publicCode, y.item.publicCode));
      const links = await db
        .selectFrom('batch_links')
        .select(['parent_batch_id', 'child_batch_id', 'mass_used_kg'])
        .where('parent_batch_id', 'in', ids)
        .where('child_batch_id', 'in', ids)
        .execute();
      const code = (bid: string) => items.get(bid)!.publicCode;
      links.sort(
        (x, y) =>
          compareCodePoints(code(x.parent_batch_id), code(y.parent_batch_id)) ||
          compareCodePoints(code(x.child_batch_id), code(y.child_batch_id)),
      );
      return {
        rootId: root.id,
        depth,
        nodes: list.map(({ item, depth: d }) => ({
          id: item.id,
          publicCode: item.publicCode,
          product: item.product,
          status: item.status,
          holder: item.holder,
          depth: d,
          accessible: visible.get(item.id) === true,
        })),
        edges: links.map((l) => ({
          parent: l.parent_batch_id,
          child: l.child_batch_id,
          massUsedKg: l.mass_used_kg,
        })),
      };
    },

    putOnSale: (p: Principal, id: string, version: number) =>
      sale(p, id, version, 'OnSale', 'putBatchOnSale'),
    markSold: (p: Principal, id: string, version: number) => sale(p, id, version, 'Sold', 'markBatchSold'),

    lockBatches,
  };
}

export type BatchesService = ReturnType<typeof batchesService>;
