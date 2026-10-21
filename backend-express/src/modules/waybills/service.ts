/**
 * Waybills (contracts/openapi/paths/waybills.yaml; FR-PROD-04/05, БП-3, R4, R47, R50, R52; the lifecycle
 * contracts/rules/waybill-state-machine.json): DRAFT → send (BR-01, BR-06) → SENT → accept (BR-06, BR-07) | reject
 * (R50c recall task reassignment); a DRAFT may be deleted.
 *
 * Visibility (tag Waybills; deleted ones are seen by nobody): FARMER/PROCESSOR/RETAILER — the organization sends it
 * (any status) or receives it (not DRAFT); INSPECTOR and ADMIN — every non-DRAFT, read-only; LAB — none (x-roles).
 * Every mutation locks the waybill first, then its batches `ORDER BY id`, then recall tasks (R52), and runs its checks
 * over the locked rows; `If-Match` is compared with the locked waybill's version.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import {
  checkDiscrepancy,
  checkWaitingPeriod,
  compareCodePoints,
  compareDecimalStrings,
  type BatchStatus,
} from '@agrotrace/domain';
import { WaybillAcceptSchema, WaybillCreateSchema, WaybillRejectSchema } from '@agrotrace/validation';
import waybillMachine from '../../../../contracts/rules/waybill-state-machine.json' with { type: 'json' };
import type { Container } from '../../container.js';
import { lockBatches, lockRecallTasks, lockWaybill } from '../../db/locks.js';
import { txNow, withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { checkVersion, type IfMatch } from '../../http/if-match.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { canBatchGo, notify, transitionBatch } from '../batches/lifecycle.js';
import { invalidTransition, notHolder } from '../batches/service.js';
import { iso, loadListItems, orgRefs, type BatchListItem, type OrganizationRef } from '../batches/view.js';
import { batchVisibleTo, isParticipant, seesAll } from '../batches/visibility.js';
import { dropPublicPages } from '../public/cache.js';

type Q = Kysely<DB> | Transaction<DB>;

const LIST_SORT = {
  fields: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  default: 'createdAt,desc',
} as const;
const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;

const canWaybillGo = (from: string, to: string): boolean =>
  waybillMachine.transitions.some((t) => t.from === from && t.to === to);

const has = (p: Principal, ...roles: string[]) => p.roles.some((r) => roles.includes(r));

const notSender = () =>
  new AppProblem(403, 'FORBIDDEN', { params: { reason: 'NOT_SENDER' }, title: 'Not the waybill sender' });
const notReceiver = () =>
  new AppProblem(403, 'FORBIDDEN', { params: { reason: 'NOT_RECEIVER' }, title: 'Not the waybill receiver' });
const businessRule = (rule: string, params: Record<string, unknown>) =>
  new AppProblem(422, 'BUSINESS_RULE', { rule, params });

type WaybillRow = {
  id: string;
  number: string;
  status: string;
  sender_org_id: string;
  receiver_org_id: string;
  created_at: unknown;
  sent_at: unknown;
  accepted_at: unknown;
  reject_reason: string | null;
  version: number;
  deleted_at: unknown;
};

/** Whether `p` sees the waybill (tag Waybills). */
function canSee(p: Principal, w: WaybillRow): boolean {
  if (w.deleted_at !== null) return false;
  if (
    isParticipant(p) &&
    (w.sender_org_id === p.orgId || (w.receiver_org_id === p.orgId && w.status !== 'DRAFT'))
  )
    return true;
  return seesAll(p) && w.status !== 'DRAFT';
}

/** The visibility predicate for lists (alias `w`). */
function visibleWhere(p: Principal) {
  const parts = [];
  if (isParticipant(p))
    parts.push(
      sql<boolean>`(w.sender_org_id = ${p.orgId} OR (w.receiver_org_id = ${p.orgId} AND w.status <> 'DRAFT'))`,
    );
  if (seesAll(p)) parts.push(sql<boolean>`w.status <> 'DRAFT'`);
  return parts.length ? sql<boolean>`(${sql.join(parts, sql` OR `)})` : sql<boolean>`false`;
}

export interface WaybillView {
  id: string;
  number: string;
  status: string;
  sender: OrganizationRef;
  receiver: OrganizationRef;
  items: {
    batch: BatchListItem;
    massDeclaredKg: string;
    massActualKg: string | null;
    discrepancyPercent: string | null;
    discrepancyAct: string | null;
  }[];
  createdAt: string;
  sentAt: string | null;
  acceptedAt: string | null;
  rejectReason: string | null;
  version: number;
  actions: string[];
}

/** Items of the waybills with their batches, each list ordered by batch publicCode (code points). */
async function itemsOf(q: Q, waybillIds: readonly string[]) {
  if (waybillIds.length === 0)
    return new Map<
      string,
      {
        batch_id: string;
        public_code: string;
        mass_declared_kg: string;
        mass_actual_kg: string | null;
        discrepancy_act: string | null;
      }[]
    >();
  const rows = await q
    .selectFrom('waybill_items as wi')
    .innerJoin('batches as b', 'b.id', 'wi.batch_id')
    .select([
      'wi.waybill_id',
      'wi.batch_id',
      'b.public_code',
      'wi.mass_declared_kg',
      'wi.mass_actual_kg',
      'wi.discrepancy_act',
    ])
    .where('wi.waybill_id', 'in', [...waybillIds])
    .execute();
  const out = new Map<string, typeof rows>();
  for (const r of rows) (out.get(r.waybill_id) ?? out.set(r.waybill_id, []).get(r.waybill_id)!).push(r);
  for (const list of out.values()) list.sort((a, b) => compareCodePoints(a.public_code, b.public_code));
  return out;
}

async function loadViews(q: Q, p: Principal, rows: WaybillRow[]): Promise<WaybillView[]> {
  const items = await itemsOf(
    q,
    rows.map((w) => w.id),
  );
  const batchIds = [...new Set([...items.values()].flat().map((i) => i.batch_id))];
  const batches = new Map((await loadListItems(q, batchIds)).map((b) => [b.id, b]));
  const orgs = await orgRefs(
    q,
    rows.flatMap((w) => [w.sender_org_id, w.receiver_org_id]),
  );
  return rows.map((w) => {
    const actions: string[] = [];
    if (w.status === 'DRAFT' && w.sender_org_id === p.orgId && has(p, 'FARMER', 'PROCESSOR'))
      actions.push('send', 'delete');
    if (w.status === 'SENT' && w.receiver_org_id === p.orgId && has(p, 'PROCESSOR', 'RETAILER'))
      actions.push('accept', 'reject');
    return {
      id: w.id,
      number: w.number,
      status: w.status,
      sender: orgs.get(w.sender_org_id)!,
      receiver: orgs.get(w.receiver_org_id)!,
      items: (items.get(w.id) ?? []).map((i) => {
        const d =
          i.mass_actual_kg === null
            ? null
            : checkDiscrepancy({ declaredKg: i.mass_declared_kg, actualKg: i.mass_actual_kg });
        return {
          batch: batches.get(i.batch_id)!,
          massDeclaredKg: i.mass_declared_kg,
          massActualKg: i.mass_actual_kg,
          discrepancyPercent: d && 'percent' in d ? d.percent : null,
          discrepancyAct: i.discrepancy_act,
        };
      }),
      createdAt: iso(w.created_at),
      sentAt: w.sent_at ? iso(w.sent_at) : null,
      acceptedAt: w.accepted_at ? iso(w.accepted_at) : null,
      rejectReason: w.reject_reason,
      version: w.version,
      actions,
    };
  });
}

const waybillAudit = (w: {
  status: string;
  version: number;
  sent_at?: unknown;
  accepted_at?: unknown;
  reject_reason?: string | null;
}) => ({
  status: w.status,
  version: w.version,
  sentAt: w.sent_at ? iso(w.sent_at) : null,
  acceptedAt: w.accepted_at ? iso(w.accepted_at) : null,
  rejectReason: w.reject_reason ?? null,
});

export function waybillsService(c: Container) {
  const { db } = c;

  async function view(q: Q, p: Principal, id: string): Promise<WaybillView> {
    const w = await q.selectFrom('waybills').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return (await loadViews(q, p, [w]))[0]!;
  }

  async function currentVersion(id: string) {
    const r = await db.selectFrom('waybills').select('version').where('id', '=', id).executeTakeFirst();
    return r ? { currentVersion: r.version } : undefined;
  }

  /** Lock the waybill, then its batches (R52); 404 for a waybill `p` does not see. */
  async function lockAll(tx: Transaction<DB>, p: Principal, id: string) {
    const w = await lockWaybill(tx, id);
    if (!w || !canSee(p, w)) throw new AppProblem(404, 'NOT_FOUND');
    const items = (await itemsOf(tx, [id])).get(id) ?? [];
    const locked = await lockBatches(
      tx,
      items.map((i) => i.batch_id),
    );
    const byId = new Map(locked.map((b) => [b.id, b]));
    return { w, items: items.map((i) => ({ item: i, batch: byId.get(i.batch_id)! })) };
  }

  return {
    /** listWaybills — direction (participants only, R51), status, counterpartyOrgId, from/to by createdAt, q. */
    async list(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
      let direction: 'incoming' | 'outgoing' | undefined;
      if (isParticipant(p)) direction = q.enumOf('direction', ['incoming', 'outgoing'] as const);
      else q.notAllowed('direction');
      const statuses = q.enumList('status', STATUSES);
      const counterparty = q.uuid('counterpartyOrgId');
      const { from, to } = q.dateRange();
      q.done();

      let base = db.selectFrom('waybills as w').where('w.deleted_at', 'is', null).where(visibleWhere(p));
      if (direction === 'outgoing') base = base.where('w.sender_org_id', '=', p.orgId);
      if (direction === 'incoming') base = base.where('w.receiver_org_id', '=', p.orgId);
      if (statuses) base = base.where('w.status', 'in', statuses);
      if (counterparty)
        base = isParticipant(p)
          ? base.where(
              sql<boolean>`CASE WHEN w.sender_org_id = ${p.orgId} THEN w.receiver_org_id ELSE w.sender_org_id END = ${counterparty}`,
            )
          : base.where((eb) =>
              eb.or([eb('w.sender_org_id', '=', counterparty), eb('w.receiver_org_id', '=', counterparty)]),
            );
      if (from) base = base.where('w.created_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('w.created_at', '<', dayAfter(to));
      if (text !== undefined)
        base = base.where(
          sql<boolean>`(position(lower(${text}) in lower(w.number)) > 0 OR EXISTS (
            SELECT 1 FROM waybill_items wi JOIN batches b ON b.id = wi.batch_id
             WHERE wi.waybill_id = w.id AND position(lower(${text}) in lower(b.public_code)) > 0))`,
        );
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = {
        createdAt: sql`w.created_at`,
        sentAt: sql`w.sent_at`,
        acceptedAt: sql`w.accepted_at`,
        number: sql`w.number COLLATE "C"`,
      }[sort.field as (typeof LIST_SORT.fields)[number]];
      const rows = await base
        .selectAll('w')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC NULLS LAST` : sql`${order} DESC NULLS LAST`)
        .orderBy(sql`w.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return { items: await loadViews(db, p, rows), page, size, total: Number(total) };
    },

    async get(p: Principal, id: string): Promise<WaybillView> {
      const w = await db.selectFrom('waybills').selectAll().where('id', '=', id).executeTakeFirst();
      if (!w || !canSee(p, w)) throw new AppProblem(404, 'NOT_FOUND');
      return (await loadViews(db, p, [w]))[0]!;
    },

    /**
     * createWaybill — body (400) → lock the existing batches of the items (`ORDER BY id`) → references (one 400 with
     * every error) → NOT_HOLDER by request order → a DRAFT with `next_waybill_number()`, version 1.
     */
    async create(p: Principal, body: unknown): Promise<WaybillView> {
      // A repeated batch is a reference error of step 2 (reported with the others), not a schema error.
      const input = parseBody(WaybillCreateSchema, body, [['items', 'massDeclaredKg']], {
        deferDuplicates: ['items'],
      });
      const receiverId = input.receiverOrgId.toLowerCase();
      const ids = input.items.map((i) => i.batchId.toLowerCase());
      const id = await withTx(db, async (tx) => {
        const locked = await lockBatches(tx, ids);
        const errors: Record<string, string[]> = {};
        const receiver = await tx
          .selectFrom('organizations')
          .select(['id', 'type', 'status'])
          .where('id', '=', receiverId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!receiver || receiver.status !== 'ACTIVE') errors.receiverOrgId = ['validation.notFound'];
        else if (receiver.type !== 'PROCESSOR' && receiver.type !== 'RETAILER')
          errors.receiverOrgId = ['validation.receiver.type'];
        else if (receiver.id === p.orgId) errors.receiverOrgId = ['validation.receiver.self'];
        const visible = new Set(
          locked.length === 0
            ? []
            : (
                await tx
                  .selectFrom('batches as b')
                  .select('b.id')
                  .where(
                    'b.id',
                    'in',
                    locked.map((b) => b.id),
                  )
                  .where('b.deleted_at', 'is', null)
                  .where(batchVisibleTo(p, sql.ref('b.id')))
                  .execute()
              ).map((r) => r.id),
        );
        const byId = new Map(locked.map((b) => [b.id, b]));
        const seen = new Set<string>();
        input.items.forEach((it, i) => {
          const bid = ids[i]!;
          if (seen.has(bid)) {
            errors[`items[${i}].batchId`] = ['validation.duplicate'];
            return;
          }
          seen.add(bid);
          const b = byId.get(bid);
          if (!b || !visible.has(bid)) {
            errors[`items[${i}].batchId`] = ['validation.notFound'];
            return;
          }
          if (compareDecimalStrings(it.massDeclaredKg, b.mass_kg) > 0)
            errors[`items[${i}].massDeclaredKg`] = ['validation.mass.exceedsBatch'];
        });
        if (Object.keys(errors).length > 0) throw validationProblem(errors);
        for (const bid of ids) {
          const b = byId.get(bid)!;
          if (b.holder_org_id !== p.orgId) throw notHolder(b.public_code);
        }
        const w = await tx
          .insertInto('waybills')
          .values({
            number: sql<string>`next_waybill_number()`,
            sender_org_id: p.orgId,
            receiver_org_id: receiverId,
            status: 'DRAFT',
            version: 1,
            created_by: p.userId,
          })
          .returning(['id', 'number'])
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('waybill_items')
          .values(
            input.items.map((it, i) => ({
              waybill_id: w.id,
              batch_id: ids[i]!,
              mass_declared_kg: it.massDeclaredKg,
            })),
          )
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createWaybill',
          entityType: 'waybill',
          entityId: w.id,
          diff: auditDiff(null, {
            number: w.number,
            senderOrgId: p.orgId,
            receiverOrgId: receiverId,
            status: 'DRAFT',
            version: 1,
            items: input.items.map((it, i) => ({ batchId: ids[i], massDeclaredKg: it.massDeclaredKg })),
          }),
        });
        return w.id;
      });
      return view(db, p, id);
    },

    /** deleteWaybill — lock → 404 (a DRAFT is seen by its sender only) → NOT_SENDER → If-Match → DRAFT only. */
    async remove(p: Principal, id: string, version: number): Promise<void> {
      await withTx(
        db,
        async (tx) => {
          const w = await lockWaybill(tx, id);
          if (!w || !canSee(p, w)) throw new AppProblem(404, 'NOT_FOUND');
          if (w.sender_org_id !== p.orgId) throw notSender();
          checkVersion(version, w.version);
          if (!canWaybillGo(w.status, 'DELETED')) throw invalidTransition({ from: w.status, to: 'DELETED' });
          const now = await txNow(tx);
          await tx.updateTable('waybills').set({ deleted_at: now }).where('id', '=', id).execute();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'deleteWaybill',
            entityType: 'waybill',
            entityId: id,
            diff: { deletedAt: [null, now.toISOString()] },
          });
        },
        { conflictParams: () => currentVersion(id) },
      );
    },

    /**
     * sendWaybill — locks waybill → batches; 404 → NOT_SENDER → If-Match → DRAFT; then per item in publicCode order:
     * NOT_HOLDER, BR-06 (Blocked/Recalled), INVALID_TRANSITION (not Approved/Accepted), BR-01 for RAW batches.
     * Result: SENT, batches InTransit (WAYBILL_SENT), WAYBILL_INCOMING to the receiver, public pages dropped.
     */
    async send(p: Principal, id: string, version: number): Promise<WaybillView> {
      const codes = await withTx(
        db,
        async (tx) => {
          const { w, items } = await lockAll(tx, p, id);
          if (w.sender_org_id !== p.orgId) throw notSender();
          checkVersion(version, w.version);
          if (!canWaybillGo(w.status, 'SENT')) throw invalidTransition({ from: w.status, to: 'SENT' });
          const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
          const shipDate = now.toISOString().slice(0, 10);
          for (const { batch: b } of items) {
            if (b.holder_org_id !== p.orgId) throw notHolder(b.public_code);
            if (b.status === 'Blocked' || b.status === 'Recalled')
              throw businessRule('BR-06', { publicCode: b.public_code, status: b.status });
            if (!canBatchGo(b.status, 'InTransit'))
              throw invalidTransition({ from: b.status, to: 'InTransit', publicCode: b.public_code });
            if (b.kind === 'RAW' && b.field_id) {
              const treatments = await tx
                .selectFrom('treatments as t')
                .innerJoin('substances as s', 's.id', 't.substance_id')
                .select(['s.name', 't.applied_at', 's.waiting_period_days'])
                .where('t.field_id', '=', b.field_id)
                .where('t.deleted_at', 'is', null)
                .execute();
              const br01 = checkWaitingPeriod({
                shipDate,
                treatments: treatments.map((t) => ({
                  substance: t.name,
                  appliedAt: iso(t.applied_at),
                  waitingPeriodDays: t.waiting_period_days,
                })),
              });
              if (!br01.ok)
                throw businessRule('BR-01', {
                  publicCode: b.public_code,
                  until: br01.until,
                  substance: br01.substance,
                });
            }
          }
          const sent = await tx
            .updateTable('waybills')
            .set({ status: 'SENT', sent_at: now, version: w.version + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'sendWaybill',
            entityType: 'waybill',
            entityId: id,
            diff: auditDiff(waybillAudit(w), waybillAudit(sent)),
          });
          for (const { batch: b } of [...items].sort((x, y) => compareCodePoints(x.batch.id, y.batch.id))) {
            const v = await transitionBatch(tx, b, 'InTransit', 'WAYBILL_SENT', p.userId);
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'sendWaybill',
              entityType: 'batch',
              entityId: b.id,
              diff: { status: [b.status, 'InTransit'], version: [b.version, v] },
            });
          }
          const sender = await tx
            .selectFrom('organizations')
            .select(['id', 'name'])
            .where('id', '=', p.orgId)
            .executeTakeFirstOrThrow();
          await notify(
            tx,
            'WAYBILL_INCOMING',
            { orgIds: [w.receiver_org_id] },
            {
              waybillId: id,
              number: w.number,
              senderOrgId: sender.id,
              senderName: sender.name,
              itemsCount: items.length,
            },
          );
          return items.map((i) => i.batch.public_code);
        },
        { conflictParams: () => currentVersion(id) },
      );
      await dropPublicPages(c.redis, codes);
      return view(db, p, id);
    },

    /**
     * acceptWaybill — locks; 404 → NOT_RECEIVER → If-Match → SENT → items match the waybill (400 items.mismatch) →
     * per item: BR-06, INVALID_TRANSITION (not InTransit), BR-07 (act required above 2%). Result: ACCEPTED, items keep
     * massActualKg/discrepancyAct, batches Accepted with the receiver as holder and the actual mass.
     */
    async accept(p: Principal, id: string, ifMatch: IfMatch, body: unknown): Promise<WaybillView> {
      // A repeated batch is step 6 (items.mismatch, after 404/403/409), not a schema error.
      const input = parseBody(WaybillAcceptSchema, body, [['items', 'massActualKg']], {
        deferDuplicates: ['items'],
        extraErrors: ifMatch.errors,
      });
      const version = ifMatch.version!;
      const codes = await withTx(
        db,
        async (tx) => {
          const { w, items } = await lockAll(tx, p, id);
          if (w.receiver_org_id !== p.orgId) throw notReceiver();
          checkVersion(version, w.version);
          if (!canWaybillGo(w.status, 'ACCEPTED'))
            throw invalidTransition({ from: w.status, to: 'ACCEPTED' });
          const byBatch = new Map(input.items.map((i) => [i.batchId.toLowerCase(), i]));
          if (
            byBatch.size !== input.items.length ||
            byBatch.size !== items.length ||
            items.some(({ batch }) => !byBatch.has(batch.id))
          )
            throw validationProblem({ items: ['validation.items.mismatch'] });
          for (const { item, batch: b } of items) {
            if (b.status === 'Blocked' || b.status === 'Recalled')
              throw businessRule('BR-06', { publicCode: b.public_code, status: b.status });
            if (b.status !== 'InTransit' || !canBatchGo(b.status, 'Accepted'))
              throw invalidTransition({ from: b.status, to: 'Accepted', publicCode: b.public_code });
            const a = byBatch.get(b.id)!;
            const d = checkDiscrepancy({ declaredKg: item.mass_declared_kg, actualKg: a.massActualKg });
            if ('percent' in d && d.actRequired && a.discrepancyAct === undefined)
              throw businessRule('BR-07', { publicCode: b.public_code, percent: d.percent });
          }
          const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
          const accepted = await tx
            .updateTable('waybills')
            .set({ status: 'ACCEPTED', accepted_at: now, version: w.version + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'acceptWaybill',
            entityType: 'waybill',
            entityId: id,
            diff: auditDiff(waybillAudit(w), waybillAudit(accepted)),
          });
          for (const { batch: b } of [...items].sort((x, y) => compareCodePoints(x.batch.id, y.batch.id))) {
            const a = byBatch.get(b.id)!;
            await tx
              .updateTable('waybill_items')
              .set({ mass_actual_kg: a.massActualKg, discrepancy_act: a.discrepancyAct ?? null })
              .where('waybill_id', '=', id)
              .where('batch_id', '=', b.id)
              .execute();
            const v = await transitionBatch(tx, b, 'Accepted', 'WAYBILL_ACCEPTED', p.userId, {
              holder_org_id: p.orgId,
              mass_kg: a.massActualKg,
            });
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'acceptWaybill',
              entityType: 'batch',
              entityId: b.id,
              diff: auditDiff(
                { status: b.status, version: b.version, holderOrgId: b.holder_org_id, massKg: b.mass_kg },
                { status: 'Accepted', version: v, holderOrgId: p.orgId, massKg: a.massActualKg },
              ),
            });
          }
          return items.map((i) => i.batch.public_code);
        },
        { conflictParams: () => currentVersion(id) },
      );
      await dropPublicPages(c.redis, codes);
      return view(db, p, id);
    },

    /**
     * rejectWaybill — body → locks (waybill, batches, then the open recall tasks of the receiver on recalled batches,
     * R52) → 404 → NOT_RECEIVER → If-Match → SENT. InTransit batches back to Approved (WAYBILL_REJECTED); a batch
     * recalled in transit: its OPEN/OVERDUE task held by the receiver goes to the sender (dueAt kept, version + 1) with
     * RECALL_TASK {event: REASSIGNED} to the sender (R50).
     */
    async reject(p: Principal, id: string, ifMatch: IfMatch, body: unknown): Promise<WaybillView> {
      const input = parseBody(WaybillRejectSchema, body, [], { extraErrors: ifMatch.errors });
      const version = ifMatch.version!;
      const codes = await withTx(
        db,
        async (tx) => {
          const { w, items } = await lockAll(tx, p, id);
          if (w.receiver_org_id !== p.orgId) throw notReceiver();
          checkVersion(version, w.version);
          if (!canWaybillGo(w.status, 'REJECTED'))
            throw invalidTransition({ from: w.status, to: 'REJECTED' });
          const recalled = items.filter((i) => i.batch.status === 'Recalled').map((i) => i.batch.id);
          const taskIds = recalled.length
            ? (
                await tx
                  .selectFrom('recall_tasks')
                  .select('id')
                  .where('batch_id', 'in', recalled)
                  .where('holder_org_id', '=', w.receiver_org_id)
                  .where('status', 'in', ['OPEN', 'OVERDUE'])
                  .execute()
              ).map((t) => t.id)
            : [];
          const tasks = await lockRecallTasks(tx, taskIds);
          const rejected = await tx
            .updateTable('waybills')
            .set({ status: 'REJECTED', reject_reason: input.reason, version: w.version + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'rejectWaybill',
            entityType: 'waybill',
            entityId: id,
            diff: auditDiff(waybillAudit(w), waybillAudit(rejected)),
          });
          const changed: string[] = [];
          for (const { batch: b } of [...items].sort((x, y) => compareCodePoints(x.batch.id, y.batch.id))) {
            if (b.status !== 'InTransit' || !canBatchGo(b.status, 'Approved' as BatchStatus)) continue;
            const v = await transitionBatch(tx, b, 'Approved', 'WAYBILL_REJECTED', p.userId);
            changed.push(b.public_code);
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'rejectWaybill',
              entityType: 'batch',
              entityId: b.id,
              diff: { status: [b.status, 'Approved'], version: [b.version, v] },
            });
          }
          const codeOf = new Map(items.map((i) => [i.batch.id, i.batch.public_code]));
          for (const t of tasks) {
            // Still open and still the receiver's after the lock (a parallel confirm or reassignment wins).
            if (t.holder_org_id !== w.receiver_org_id || (t.status !== 'OPEN' && t.status !== 'OVERDUE'))
              continue;
            await tx
              .updateTable('recall_tasks')
              .set({ holder_org_id: w.sender_org_id, version: t.version + 1 })
              .where('id', '=', t.id)
              .execute();
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'rejectWaybill',
              entityType: 'recallTask',
              entityId: t.id,
              diff: { holderOrgId: [t.holder_org_id, w.sender_org_id], version: [t.version, t.version + 1] },
            });
            await notify(
              tx,
              'RECALL_TASK',
              { orgIds: [w.sender_org_id] },
              {
                recallId: t.recall_id,
                taskId: t.id,
                batchId: t.batch_id,
                publicCode: codeOf.get(t.batch_id),
                dueAt: iso(t.due_at),
                event: 'REASSIGNED',
              },
            );
          }
          return changed;
        },
        { conflictParams: () => currentVersion(id) },
      );
      await dropPublicPages(c.redis, codes);
      return view(db, p, id);
    },
  };
}
