/**
 * The recall engine core (contract tag Recalls, steps 1–7; P2): synchronous, inside the transaction of the operation
 * that starts it (submitLabResults with FAIL, createRecall, decideComplaint with RECALL), which runs
 * at REPEATABLE READ (R54/D7, `RECALL_TX`).
 *
 *   1. an OPEN recall of the source → reused, steps 2–7 skipped (`findOpenRecall`); a concurrent creation hits
 *      `ux_recalls_open_source` (23505) → the whole transaction is repeated once (`RECALL_TX.retryIf`);
 *   2. `recallScope`: DOWN — all descendants, depth 1…20; UP — all ancestors (only with `blockUpstream`), depth 1…20;
 *      each batch once at its smallest depth; the walk passes through soft-deleted batches, which are not members;
 *   3. the caller locks the source and every member in ONE `FOR NO KEY UPDATE ORDER BY id` (R52 `batches`) — a member
 *      changed after the snapshot fails with 40001 and the transaction is repeated (R47), so a link added by a
 *      parallel processing is never missed (`startRecall` does steps 1–3 for callers with nothing else to lock);
 *   4–7. `applyRecall`: the `recalls` row, `recall_batches`, Recalled transitions (RECALLED, by the requesting user),
 *      a task per transitioned batch (holder; for an InTransit batch — the receiver of its SENT waybill, T9 note c),
 *      `due_at` = BR-08 `recallTaskDueAt(opened_at)`; no task → CLOSED at once (BR-10, closed_at = opened_at,
 *      version 2) with `notification.dispatch` RECALL {event: CLOSED} to the inspectors (R59). A NEW recall always
 *      writes `recall.requested` (its handler fans out OPENED/CREATED and the rating; for a recall already closed it
 *      sends no OPENED — R89).
 *
 * Callers add their own lab/complaint rows, drop the public pages of `changedCodes` after the commit (R82) and
 * publish nothing themselves: the outbox relay does (R55).
 */
import { sql, type Transaction } from 'kysely';
import { compareCodePoints, recallTaskDueAt, shouldCloseRecall } from '@agrotrace/domain';
import { lockBatches } from '../../db/locks.js';
import type { TxOptions } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { enqueue } from '../../infra/outbox.js';
import { auditDiff, auditService } from '../audit/service.js';
import { canBatchGo, notify, transitionBatch } from '../batches/lifecycle.js';
import { iso } from '../batches/view.js';

type Tx = Transaction<DB>;

/** Depth bound of the graph walk (п. 7.6). */
export const RECALL_MAX_DEPTH = 20;

export type RecallTrigger = 'LAB' | 'INSPECTOR' | 'COMPLAINT';
export type RecallDirection = 'SOURCE' | 'DOWN' | 'UP';

/** Transaction options of every operation that runs the engine (REPEATABLE READ; repeat on the open-source race). */
export const RECALL_TX: TxOptions = {
  isolation: 'repeatable read',
  retryIf: (err) =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === 'ux_recalls_open_source',
};

export interface RecallRequest {
  sourceBatchId: string;
  trigger: RecallTrigger;
  reason: string;
  blockUpstream: boolean;
  labTestId?: string | null;
  complaintId?: string | null;
  /** The user whose request opened the recall (`created_by`, the author of the transitions). */
  actorId: string;
  /** operationId for the audit rows. */
  action: string;
}

export interface ScopeMember {
  batchId: string;
  direction: RecallDirection;
  depth: number;
}

/** A locked `batches` row as the engine needs it (the caller's lock, possibly already moved, e.g. OnTest → Blocked). */
export interface LockedBatch {
  id: string;
  public_code: string;
  status: string;
  version: number;
  holder_org_id: string | null;
}

export interface RecallOutcome {
  recallId: string;
  /** false — an OPEN recall of the source was reused (steps 2–7 skipped). */
  created: boolean;
  /** Closed at creation (BR-10, no task). */
  closed: boolean;
  /** Batches moved to Recalled — their public pages are dropped after the commit (R82). */
  changedCodes: string[];
  taskIds: string[];
  /** Outbox rows to publish right after the commit (`recall.requested` of a new recall; R55 relay). */
  eventIds: string[];
}

/** Step 1: the OPEN recall of the source batch, if any. */
export async function findOpenRecall(tx: Tx, sourceBatchId: string): Promise<{ id: string } | undefined> {
  return tx
    .selectFrom('recalls')
    .select('id')
    .where('source_batch_id', '=', sourceBatchId)
    .where('status', '=', 'OPEN')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/**
 * Step 2 (raw recursive SQL, п. 7.6): the source (SOURCE, 0) and its descendants (DOWN) — plus its ancestors (UP) when
 * `blockUpstream` — at their smallest depth 1…20; soft-deleted batches are walked through but left out. Ordered by id.
 */
export async function recallScope(
  tx: Tx,
  sourceBatchId: string,
  blockUpstream: boolean,
): Promise<ScopeMember[]> {
  const walk = (dir: 'DOWN' | 'UP') => {
    const [from, to] =
      dir === 'DOWN' ? ['parent_batch_id', 'child_batch_id'] : ['child_batch_id', 'parent_batch_id'];
    return sql<{ id: string; depth: number }>`
      WITH RECURSIVE walk(id, depth) AS (
        SELECT l.${sql.ref(to)}, 1 FROM batch_links l WHERE l.${sql.ref(from)} = ${sourceBatchId}
        UNION
        SELECT l.${sql.ref(to)}, w.depth + 1 FROM batch_links l JOIN walk w ON l.${sql.ref(from)} = w.id
         WHERE w.depth < ${RECALL_MAX_DEPTH}
      )
      SELECT w.id, min(w.depth)::int AS depth FROM walk w JOIN batches b ON b.id = w.id
       WHERE b.deleted_at IS NULL AND w.id <> ${sourceBatchId}
       GROUP BY w.id`.execute(tx);
  };
  const members: ScopeMember[] = [{ batchId: sourceBatchId, direction: 'SOURCE', depth: 0 }];
  const seen = new Set([sourceBatchId]);
  for (const r of (await walk('DOWN')).rows) {
    seen.add(r.id);
    members.push({ batchId: r.id, direction: 'DOWN', depth: r.depth });
  }
  if (blockUpstream)
    for (const r of (await walk('UP')).rows)
      if (!seen.has(r.id)) members.push({ batchId: r.id, direction: 'UP', depth: r.depth });
  return members.sort((a, b) => compareCodePoints(a.batchId, b.batchId));
}

/** The organization holding the recall task of a batch: its holder, or for InTransit the SENT waybill's receiver. */
async function taskHolder(tx: Tx, b: LockedBatch, statusBefore: string): Promise<string | null> {
  if (statusBefore === 'InTransit') {
    const w = await tx
      .selectFrom('waybills as w')
      .innerJoin('waybill_items as wi', 'wi.waybill_id', 'w.id')
      .select('w.receiver_org_id')
      .where('wi.batch_id', '=', b.id)
      .where('w.status', '=', 'SENT')
      .where('w.deleted_at', 'is', null)
      .executeTakeFirst();
    if (w) return w.receiver_org_id;
  }
  return b.holder_org_id;
}

/**
 * Steps 4–7 over the locked members (`locked` holds every member's locked row, the source included — in its current
 * state). Assumes step 1 found no OPEN recall.
 */
export async function applyRecall(
  tx: Tx,
  req: RecallRequest,
  members: readonly ScopeMember[],
  locked: ReadonlyMap<string, LockedBatch>,
): Promise<RecallOutcome> {
  const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
  const source = locked.get(req.sourceBatchId);
  if (!source) throw new Error(`recall source ${req.sourceBatchId} is not locked`);
  const recall = await tx
    .insertInto('recalls')
    .values({
      source_batch_id: req.sourceBatchId,
      trigger: req.trigger,
      reason: req.reason,
      status: 'OPEN',
      block_upstream: req.blockUpstream,
      lab_test_id: req.labTestId ?? null,
      complaint_id: req.complaintId ?? null,
      opened_at: now,
      version: 1,
      created_by: req.actorId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const dueAt = recallTaskDueAt({ openedAt: now.toISOString() }).dueAt;
  const changedCodes: string[] = [];
  const taskIds: string[] = [];
  const tasks: { id: string; batch: LockedBatch; holder: string }[] = [];
  for (const m of [...members].sort((a, b) => compareCodePoints(a.batchId, b.batchId))) {
    const b = locked.get(m.batchId);
    if (!b) continue; // deleted between the walk and the lock: not a member
    const before = b.status;
    await tx
      .insertInto('recall_batches')
      .values({
        recall_id: recall.id,
        batch_id: b.id,
        direction: m.direction,
        depth: m.depth,
        status_before: before,
      })
      .execute();
    // Processed, Sold, WrittenOff and already Recalled keep their status and get no task (п. 5.1).
    if (!canBatchGo(before, 'Recalled')) continue;
    const holder = await taskHolder(tx, b, before);
    const v = await transitionBatch(tx, b, 'Recalled', 'RECALLED', req.actorId);
    changedCodes.push(b.public_code);
    await auditService.record(tx, {
      actorId: req.actorId,
      action: req.action,
      entityType: 'batch',
      entityId: b.id,
      diff: { status: [before, 'Recalled'], version: [b.version, v] },
    });
    if (holder === null) continue;
    const task = await tx
      .insertInto('recall_tasks')
      .values({
        recall_id: recall.id,
        holder_org_id: holder,
        batch_id: b.id,
        due_at: dueAt,
        status: 'OPEN',
        version: 1,
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    taskIds.push(task.id);
    tasks.push({ id: task.id, batch: b, holder });
    await auditService.record(tx, {
      actorId: req.actorId,
      action: req.action,
      entityType: 'recallTask',
      entityId: task.id,
      diff: auditDiff(null, {
        recallId: recall.id,
        batchId: b.id,
        holderOrgId: holder,
        dueAt,
        status: 'OPEN',
        version: 1,
      }),
    });
  }

  const closed = shouldCloseRecall({ taskStatuses: tasks.map(() => 'OPEN') }).close;
  if (closed)
    await tx
      .updateTable('recalls')
      .set({ status: 'CLOSED', closed_at: now, version: 2 })
      .where('id', '=', recall.id)
      .execute();
  await auditService.record(tx, {
    actorId: req.actorId,
    action: req.action,
    entityType: 'recall',
    entityId: recall.id,
    diff: auditDiff(null, {
      sourceBatchId: req.sourceBatchId,
      trigger: req.trigger,
      reason: req.reason,
      status: closed ? 'CLOSED' : 'OPEN',
      blockUpstream: req.blockUpstream,
      labTestId: req.labTestId ?? null,
      complaintId: req.complaintId ?? null,
      openedAt: iso(now),
      closedAt: closed ? iso(now) : null,
      version: closed ? 2 : 1,
    }),
  });
  if (closed)
    await notify(
      tx,
      'RECALL',
      { roles: ['INSPECTOR'] },
      {
        recallId: recall.id,
        event: 'CLOSED',
        sourceBatchId: req.sourceBatchId,
        publicCode: source.public_code,
        trigger: req.trigger,
      },
    );
  const requested = await enqueue(tx, {
    type: 'recall.requested',
    payload: {
      recallId: recall.id,
      sourceBatchId: req.sourceBatchId,
      trigger: req.trigger,
      openedBy: req.actorId,
    },
  });
  return { recallId: recall.id, created: true, closed, changedCodes, taskIds, eventIds: [requested.id] };
}

/**
 * Steps 1–7 for an operation that locks nothing else of the batches (createRecall, decideComplaint RECALL): reuse →
 * scope → one `FOR NO KEY UPDATE ORDER BY id` over the source and the members → apply. Run inside `withTx(db, …, RECALL_TX)`.
 */
export async function startRecall(tx: Tx, req: RecallRequest): Promise<RecallOutcome> {
  const open = await findOpenRecall(tx, req.sourceBatchId);
  if (open)
    return { recallId: open.id, created: false, closed: false, changedCodes: [], taskIds: [], eventIds: [] };
  const members = await recallScope(tx, req.sourceBatchId, req.blockUpstream);
  const rows = await lockBatches(
    tx,
    members.map((m) => m.batchId),
  );
  return applyRecall(tx, req, members, new Map(rows.map((r) => [r.id, r])));
}
