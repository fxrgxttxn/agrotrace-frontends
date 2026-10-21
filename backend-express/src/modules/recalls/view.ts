/**
 * The contract's recall views (contracts/openapi/schemas/recalls.yaml): `RecallTask`, `RecallListItem`, `Recall`,
 * `RecallGraph`, `ActorRef`. `overdue` and `progress.overdue` are computed at read time by the DB clock: a task not
 * CONFIRMED with now() > due_at, whether or not the scheduler has set OVERDUE yet. Fixed orders of the contract compare
 * strings by code points (`COLLATE "C"`, P14).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import type { FileUrls } from '../../infra/file-urls.js';
import {
  iso,
  loadListItems,
  orgRefs,
  type BatchListItem,
  type OrganizationRef,
  type ProductRef,
} from '../batches/view.js';

type Q = Kysely<DB> | Transaction<DB>;

const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

export interface ActorRef {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

/** ActorRef of users by id (avatars as signed URLs). */
export async function actorRefs(
  q: Q,
  urls: FileUrls,
  ids: readonly (string | null)[],
): Promise<Map<string, ActorRef>> {
  const want = [...new Set(ids.filter((x): x is string => x !== null))];
  if (want.length === 0) return new Map();
  const rows = await q
    .selectFrom('users')
    .select(['id', 'full_name', 'avatar_file_id'])
    .where('id', 'in', want)
    .execute();
  return new Map(
    rows.map((u) => [
      u.id,
      { id: u.id, fullName: u.full_name, avatarUrl: u.avatar_file_id ? urls.signed(u.avatar_file_id) : null },
    ]),
  );
}

export interface RecallTaskView {
  id: string;
  recallId: string;
  recallReason: string;
  batch: BatchListItem;
  holder: OrganizationRef;
  dueAt: string;
  status: string;
  overdue: boolean;
  escalatedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: ActorRef | null;
  createdAt: string;
  version: number;
}

/** `RecallTask` of `ids`, in the order of `ids`. */
export async function loadTaskItems(q: Q, urls: FileUrls, ids: readonly string[]): Promise<RecallTaskView[]> {
  if (ids.length === 0) return [];
  const rows = await q
    .selectFrom('recall_tasks as t')
    .innerJoin('recalls as r', 'r.id', 't.recall_id')
    .select([
      't.id',
      't.recall_id',
      't.batch_id',
      't.holder_org_id',
      't.due_at',
      't.status',
      't.escalated_at',
      't.confirmed_at',
      't.confirmed_by',
      't.created_at',
      't.version',
      'r.reason',
      sql<boolean>`(t.status <> 'CONFIRMED' AND now() > t.due_at)`.as('overdue'),
    ])
    .where('t.id', 'in', [...ids])
    .execute();
  const batches = new Map(
    (
      await loadListItems(
        q,
        rows.map((r) => r.batch_id),
      )
    ).map((b) => [b.id, b]),
  );
  const holders = await orgRefs(
    q,
    rows.map((r) => r.holder_org_id),
  );
  const actors = await actorRefs(
    q,
    urls,
    rows.map((r) => r.confirmed_by),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id: r.id,
        recallId: r.recall_id,
        recallReason: r.reason,
        batch: batches.get(r.batch_id)!,
        holder: holders.get(r.holder_org_id)!,
        dueAt: iso(r.due_at),
        status: r.status,
        overdue: r.overdue,
        escalatedAt: isoOrNull(r.escalated_at),
        confirmedAt: isoOrNull(r.confirmed_at),
        confirmedBy: r.confirmed_by ? (actors.get(r.confirmed_by) ?? null) : null,
        createdAt: iso(r.created_at),
        version: r.version,
      },
    ];
  });
}

export interface RecallListItemView {
  id: string;
  sourceBatch: BatchListItem;
  trigger: string;
  reason: string;
  status: string;
  blockUpstream: boolean;
  openedAt: string;
  closedAt: string | null;
  progress: { confirmed: number; total: number; overdue: number };
  batchesCount: number;
}

/** `RecallListItem` of `ids`, in the order of `ids`. */
export async function loadRecallItems(q: Q, ids: readonly string[]): Promise<RecallListItemView[]> {
  if (ids.length === 0) return [];
  const rows = await q
    .selectFrom('recalls as r')
    .select([
      'r.id',
      'r.source_batch_id',
      'r.trigger',
      'r.reason',
      'r.status',
      'r.block_upstream',
      'r.opened_at',
      'r.closed_at',
      sql<number>`(SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id)::int`.as('total'),
      sql<number>`(SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED')::int`.as(
        'confirmed',
      ),
      sql<number>`(SELECT count(*) FROM recall_tasks t
                    WHERE t.recall_id = r.id AND t.status <> 'CONFIRMED' AND now() > t.due_at)::int`.as(
        'overdue',
      ),
      sql<number>`(SELECT count(*) FROM recall_batches rb WHERE rb.recall_id = r.id)::int`.as(
        'batches_count',
      ),
    ])
    .where('r.id', 'in', [...ids])
    .execute();
  const sources = new Map(
    (
      await loadListItems(
        q,
        rows.map((r) => r.source_batch_id),
      )
    ).map((b) => [b.id, b]),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id: r.id,
        sourceBatch: sources.get(r.source_batch_id)!,
        trigger: r.trigger,
        reason: r.reason,
        status: r.status,
        blockUpstream: r.block_upstream,
        openedAt: iso(r.opened_at),
        closedAt: isoOrNull(r.closed_at),
        progress: { confirmed: r.confirmed, total: r.total, overdue: r.overdue },
        batchesCount: r.batches_count,
      },
    ];
  });
}

/** `recall_batches` of the recall in the contract's order: SOURCE, DOWN, UP, then depth, then publicCode. */
async function members(q: Q, recallId: string) {
  return q
    .selectFrom('recall_batches as rb')
    .innerJoin('batches as b', 'b.id', 'rb.batch_id')
    .select(['rb.batch_id', 'rb.direction', 'rb.depth', 'rb.status_before', 'b.public_code'])
    .where('rb.recall_id', '=', recallId)
    .orderBy(sql`CASE rb.direction WHEN 'SOURCE' THEN 0 WHEN 'DOWN' THEN 1 ELSE 2 END`)
    .orderBy('rb.depth')
    .orderBy(sql`b.public_code COLLATE "C"`)
    .orderBy('rb.batch_id')
    .execute();
}

/** Task ids of the recall in the contract's order: dueAt, then the batch's publicCode. */
async function taskIdsOf(q: Q, recallId: string): Promise<string[]> {
  const rows = await q
    .selectFrom('recall_tasks as t')
    .innerJoin('batches as b', 'b.id', 't.batch_id')
    .select('t.id')
    .where('t.recall_id', '=', recallId)
    .orderBy('t.due_at')
    .orderBy(sql`b.public_code COLLATE "C"`)
    .orderBy(sql`t.id::text COLLATE "C"`)
    .execute();
  return rows.map((r) => r.id);
}

export interface RecallView extends RecallListItemView {
  openedBy: ActorRef | null;
  labTestId: string | null;
  complaintId: string | null;
  batches: { batch: BatchListItem; direction: string; depth: number; statusBefore: string }[];
  tasks: RecallTaskView[];
  version: number;
}

/** The `Recall` card of a non-deleted recall, or undefined. */
export async function loadRecall(q: Q, urls: FileUrls, id: string): Promise<RecallView | undefined> {
  const r = await q
    .selectFrom('recalls')
    .select(['id', 'created_by', 'lab_test_id', 'complaint_id', 'version'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!r) return undefined;
  const [item] = await loadRecallItems(q, [id]);
  const ms = await members(q, id);
  const items = new Map(
    (
      await loadListItems(
        q,
        ms.map((m) => m.batch_id),
      )
    ).map((b) => [b.id, b]),
  );
  const actors = await actorRefs(q, urls, [r.created_by]);
  return {
    ...item!,
    openedBy: r.created_by ? (actors.get(r.created_by) ?? null) : null,
    labTestId: r.lab_test_id,
    complaintId: r.complaint_id,
    batches: ms.map((m) => ({
      batch: items.get(m.batch_id)!,
      direction: m.direction,
      depth: m.depth,
      statusBefore: m.status_before,
    })),
    tasks: await loadTaskItems(q, urls, await taskIdsOf(q, id)),
    version: r.version,
  };
}

export interface RecallGraphView {
  recallId: string;
  nodes: {
    id: string;
    publicCode: string;
    product: ProductRef;
    status: string;
    statusBefore: string;
    holder: OrganizationRef;
    direction: string;
    depth: number;
    taskStatus: string | null;
  }[];
  edges: { parent: string; child: string; massUsedKg: string }[];
}

/** `RecallGraph` of a non-deleted recall, or undefined. */
export async function loadRecallGraph(q: Q, id: string): Promise<RecallGraphView | undefined> {
  const r = await q
    .selectFrom('recalls')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!r) return undefined;
  const ms = await members(q, id);
  const ids = ms.map((m) => m.batch_id);
  const items = new Map((await loadListItems(q, ids)).map((b) => [b.id, b]));
  const tasks = new Map(
    (
      await q.selectFrom('recall_tasks').select(['batch_id', 'status']).where('recall_id', '=', id).execute()
    ).map((t) => [t.batch_id, t.status]),
  );
  const edges =
    ids.length === 0
      ? []
      : await q
          .selectFrom('batch_links as l')
          .innerJoin('batches as p', 'p.id', 'l.parent_batch_id')
          .innerJoin('batches as c', 'c.id', 'l.child_batch_id')
          .select(['l.parent_batch_id', 'l.child_batch_id', 'l.mass_used_kg'])
          .where('l.parent_batch_id', 'in', ids)
          .where('l.child_batch_id', 'in', ids)
          .orderBy(sql`p.public_code COLLATE "C"`)
          .orderBy(sql`c.public_code COLLATE "C"`)
          .execute();
  return {
    recallId: id,
    nodes: ms.map((m) => {
      const b = items.get(m.batch_id)!;
      return {
        id: b.id,
        publicCode: b.publicCode,
        product: b.product,
        status: b.status,
        statusBefore: m.status_before,
        holder: b.holder,
        direction: m.direction,
        depth: m.depth,
        taskStatus: tasks.get(b.id) ?? null,
      };
    }),
    edges: edges.map((e) => ({
      parent: e.parent_batch_id,
      child: e.child_batch_id,
      massUsedKg: e.mass_used_kg,
    })),
  };
}
