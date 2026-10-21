/**
 * Recalls and recall tasks (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml; БП-5, FR-QA-06/07, BR-08, BR-10,
 * R47/R52/R54): the register, the card and the graph (INSPECTOR, ADMIN), the manual recall (INSPECTOR — the engine,
 * engine.ts, at REPEATABLE READ), the tasks (their holders and INSPECTOR) and their confirmation.
 *
 * confirmRecallTask locks in the R52 order: the task is read without a lock to learn its recall and batch, then the
 * recall `FOR NO KEY UPDATE`, the batch `FOR NO KEY UPDATE`, the task `FOR NO KEY UPDATE`; every check from 404 on runs over the locked
 * rows, `If-Match` is compare-and-set on the task. Two confirmations of one recall serialize on the recall row, so
 * exactly one of them sees every task CONFIRMED and closes it (BR-10).
 */
import { sql, type Transaction } from 'kysely';
import type { Request } from 'express';
import { shouldCloseRecall } from '@agrotrace/domain';
import { RecallCreateSchema, RecallTaskConfirmSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { lockBatches, lockRecallTasks } from '../../db/locks.js';
import { withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { checkVersion, type IfMatch } from '../../http/if-match.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { notify, transitionBatch } from '../batches/lifecycle.js';
import { invalidTransition } from '../batches/service.js';
import { iso } from '../batches/view.js';
import { dropPublicPages } from '../public/cache.js';
import { RECALL_TX, startRecall, type RecallTrigger } from './engine.js';
import {
  loadRecall,
  loadRecallGraph,
  loadRecallItems,
  loadTaskItems,
  type RecallGraphView,
  type RecallTaskView,
  type RecallView,
} from './view.js';

type Tx = Transaction<DB>;

const RECALL_SORT = { fields: ['openedAt', 'closedAt'], default: 'openedAt,desc' } as const;
const TASK_SORT = { fields: ['dueAt', 'createdAt', 'confirmedAt'], default: 'dueAt,asc' } as const;
const TRIGGERS = ['LAB', 'INSPECTOR', 'COMPLAINT'] as const;
const TASK_STATUSES = ['OPEN', 'CONFIRMED', 'OVERDUE'] as const;

const notFound = () => new AppProblem(404, 'NOT_FOUND');

const taskAudit = (t: {
  status: string;
  confirmed_at: unknown;
  confirmed_by: string | null;
  version: number;
}) => ({
  status: t.status,
  confirmedAt: t.confirmed_at ? iso(t.confirmed_at) : null,
  confirmedBy: t.confirmed_by,
  version: t.version,
});

/** Applies `x-sort` with nulls last and the id tie-break (contract "Списки"). */
function order(dir: 'asc' | 'desc', column: ReturnType<typeof sql>) {
  return dir === 'asc' ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;
}

export function recallsService(c: Container) {
  const { db } = c;

  async function card(id: string): Promise<RecallView> {
    const r = await loadRecall(db, c.fileUrls, id);
    if (!r) throw notFound();
    return r;
  }

  async function taskVersion(id: string) {
    const r = await db.selectFrom('recall_tasks').select('version').where('id', '=', id).executeTakeFirst();
    return r ? { currentVersion: r.version } : undefined;
  }

  return {
    /** listRecalls — every non-deleted recall; filters joined by AND; `x-sort`. */
    async list(query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(RECALL_SORT);
      const text = q.q();
      const status = q.enumOf('status', ['OPEN', 'CLOSED'] as const);
      const triggers = q.enumList('trigger', TRIGGERS);
      const batchId = q.uuid('batchId');
      const { from, to } = q.dateRange();
      q.done();
      let base = db
        .selectFrom('recalls as r')
        .innerJoin('batches as b', 'b.id', 'r.source_batch_id')
        .where('r.deleted_at', 'is', null);
      if (status) base = base.where('r.status', '=', status);
      if (triggers) base = base.where('r.trigger', 'in', triggers);
      if (batchId)
        base = base.where(
          sql<boolean>`EXISTS (SELECT 1 FROM recall_batches rb WHERE rb.recall_id = r.id AND rb.batch_id = ${batchId})`,
        );
      // from/to — by the UTC date of openedAt (UTC midnights, whatever the process TZ).
      if (from) base = base.where('r.opened_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('r.opened_at', '<', dayAfter(to));
      if (text !== undefined)
        base = base.where(sql<boolean>`position(lower(${text}) in lower(b.public_code)) > 0`);
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const column = sort.field === 'closedAt' ? sql`r.closed_at` : sql`r.opened_at`;
      const rows = await base
        .select('r.id')
        .orderBy(order(sort.dir, column))
        .orderBy(sql`r.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadRecallItems(
          db,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    get: (id: string): Promise<RecallView> => card(id),

    async graph(id: string): Promise<RecallGraphView> {
      const g = await loadRecallGraph(db, id);
      if (!g) throw notFound();
      return g;
    },

    /**
     * createRecall — body (400) → the source non-deleted (else 400 sourceBatchId notFound; any status) → the engine
     * (trigger INSPECTOR, the body's reason and blockUpstream, the user as author). 201 — a new recall (its pages
     * dropped and `recall.requested` published after the commit); 200 — the OPEN recall of the source, unchanged.
     */
    async create(p: Principal, body: unknown): Promise<{ status: 200 | 201; body: RecallView }> {
      const input = parseBody(RecallCreateSchema, body);
      const sourceBatchId = input.sourceBatchId.toLowerCase();
      const outcome = await withTx(
        db,
        async (tx) => {
          const src = await tx
            .selectFrom('batches')
            .select('id')
            .where('id', '=', sourceBatchId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (!src) throw validationProblem({ sourceBatchId: ['validation.notFound'] });
          return startRecall(tx, {
            sourceBatchId,
            trigger: 'INSPECTOR' satisfies RecallTrigger,
            reason: input.reason,
            blockUpstream: input.blockUpstream,
            actorId: p.userId,
            action: 'createRecall',
          });
        },
        RECALL_TX,
      );
      await dropPublicPages(c.redis, outcome.changedCodes);
      await c.relay.publish(outcome.eventIds);
      return { status: outcome.created ? 201 : 200, body: await card(outcome.recallId) };
    },

    /** listRecallTasks — holders see their organization's tasks, INSPECTOR every task (R51 for holderOrgId). */
    async listTasks(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(TASK_SORT);
      const text = q.q();
      const statuses = q.enumList('status', TASK_STATUSES);
      const overdue = q.bool('overdue');
      const recallId = q.uuid('recallId');
      const inspector = p.roles.includes('INSPECTOR');
      let holderOrgId: string | undefined;
      if (inspector) holderOrgId = q.uuid('holderOrgId');
      else q.notAllowed('holderOrgId');
      q.done();
      const overdueSql = sql<boolean>`(t.status <> 'CONFIRMED' AND now() > t.due_at)`;
      let base = db
        .selectFrom('recall_tasks as t')
        .innerJoin('recalls as r', 'r.id', 't.recall_id')
        .innerJoin('batches as b', 'b.id', 't.batch_id')
        .where('r.deleted_at', 'is', null);
      if (!inspector) base = base.where('t.holder_org_id', '=', p.orgId);
      if (statuses) base = base.where('t.status', 'in', statuses);
      if (overdue !== undefined) base = base.where(overdue ? overdueSql : sql<boolean>`NOT ${overdueSql}`);
      if (recallId) base = base.where('t.recall_id', '=', recallId);
      if (holderOrgId) base = base.where('t.holder_org_id', '=', holderOrgId);
      if (text !== undefined)
        base = base.where(sql<boolean>`position(lower(${text}) in lower(b.public_code)) > 0`);
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const column = { dueAt: sql`t.due_at`, createdAt: sql`t.created_at`, confirmedAt: sql`t.confirmed_at` }[
        sort.field as (typeof TASK_SORT.fields)[number]
      ];
      const rows = await base
        .select('t.id')
        .orderBy(order(sort.dir, column))
        .orderBy(sql`t.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadTaskItems(
          db,
          c.fileUrls,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    /**
     * confirmRecallTask — body/If-Match (one 400) → locks (recall → batch → task) → 404 (holder ≠ the user's
     * organization) → If-Match → CONFIRMED → batch not Recalled → the task CONFIRMED, the batch WrittenOff, and — the
     * last open task — the recall CLOSED with RECALL CLOSED to the inspectors.
     */
    async confirm(p: Principal, id: string, ifMatch: IfMatch, body: unknown): Promise<RecallTaskView> {
      parseBody(RecallTaskConfirmSchema, body ?? {}, [], { extraErrors: ifMatch.errors });
      const version = ifMatch.version!;
      const codes = await withTx(
        db,
        async (tx: Tx) => {
          const t0 = await tx
            .selectFrom('recall_tasks')
            .select(['recall_id', 'batch_id'])
            .where('id', '=', id)
            .executeTakeFirst();
          if (!t0) throw notFound();
          const recall = await tx
            .selectFrom('recalls')
            .selectAll()
            .where('id', '=', t0.recall_id)
            .forNoKeyUpdate()
            .executeTakeFirstOrThrow();
          const [b] = await lockBatches(tx, [t0.batch_id]);
          const [t] = await lockRecallTasks(tx, [id]);
          if (!t || !b || recall.deleted_at !== null || t.holder_org_id !== p.orgId) throw notFound();
          checkVersion(version, t.version);
          if (t.status === 'CONFIRMED') throw invalidTransition({ from: 'CONFIRMED', to: 'CONFIRMED' });
          if (b.status !== 'Recalled')
            throw invalidTransition({ from: b.status, to: 'WrittenOff', publicCode: b.public_code });

          const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
          const after = await tx
            .updateTable('recall_tasks')
            .set({ status: 'CONFIRMED', confirmed_at: now, confirmed_by: p.userId, version: t.version + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'confirmRecallTask',
            entityType: 'recallTask',
            entityId: id,
            diff: auditDiff(taskAudit(t), taskAudit(after)),
          });
          const v = await transitionBatch(tx, b, 'WrittenOff', 'WRITTEN_OFF', p.userId);
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'confirmRecallTask',
            entityType: 'batch',
            entityId: b.id,
            diff: { status: [b.status, 'WrittenOff'], version: [b.version, v] },
          });

          const statuses = await tx
            .selectFrom('recall_tasks')
            .select('status')
            .where('recall_id', '=', recall.id)
            .execute();
          if (
            recall.status === 'OPEN' &&
            shouldCloseRecall({ taskStatuses: statuses.map((s) => s.status) }).close
          ) {
            await tx
              .updateTable('recalls')
              .set({ status: 'CLOSED', closed_at: now, version: recall.version + 1 })
              .where('id', '=', recall.id)
              .execute();
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'confirmRecallTask',
              entityType: 'recall',
              entityId: recall.id,
              diff: {
                status: ['OPEN', 'CLOSED'],
                closedAt: [null, iso(now)],
                version: [recall.version, recall.version + 1],
              },
            });
            const source = await tx
              .selectFrom('batches')
              .select('public_code')
              .where('id', '=', recall.source_batch_id)
              .executeTakeFirstOrThrow();
            await notify(
              tx,
              'RECALL',
              { roles: ['INSPECTOR'] },
              {
                recallId: recall.id,
                event: 'CLOSED',
                sourceBatchId: recall.source_batch_id,
                publicCode: source.public_code,
                trigger: recall.trigger,
              },
            );
          }
          return [b.public_code];
        },
        { conflictParams: () => taskVersion(id) },
      );
      await dropPublicPages(c.redis, codes);
      const [view] = await loadTaskItems(db, c.fileUrls, [id]);
      return view!;
    },
  };
}
