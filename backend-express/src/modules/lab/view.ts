/**
 * Lab test views (contracts/openapi/schemas/lab.yaml: `LabTestListItem`, `LabTest`) and visibility (tag Lab):
 * deleted tests (and tests of deleted batches) are seen by nobody; INSPECTOR/ADMIN — all; LAB — its own laboratory's
 * tests; FARMER/PROCESSOR/RETAILER — tests of the batches they see (tag Batches, S ∪ N; a LAB role adds nothing
 * there). `overdue` is computed at read time by the DB clock: open status and now() > due_at (isOverdue).
 *
 * `norms`: while not DONE — the current norms of the batch's product with non-deleted indicators; for DONE — the
 * snapshot of the results (maxValue = normValue); both ordered by indicator name (code points), then indicatorId.
 */
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import type { FileUrls } from '../../infra/file-urls.js';
import type { Principal } from '../../security/jwt.js';
import { iso, loadListItems, orgRefs, type BatchListItem, type OrganizationRef } from '../batches/view.js';
import { batchVisibleTo, isParticipant, seesAll } from '../batches/visibility.js';
import { fileRef, type FileRef } from '../files/service.js';

type Q = Kysely<DB> | Transaction<DB>;

/** Statuses whose results can still be submitted (entity-state-machines.json labTest → DONE). */
export const LAB_OPEN = ['QUEUED', 'SAMPLED', 'ESCALATED'] as const;

const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** Visibility of the test `t` (alias) whose batch is `b` (alias) — deletion is the caller's filter. */
export function labTestVisibleTo(p: Principal): RawBuilder<boolean> {
  if (seesAll(p)) return sql<boolean>`true`;
  const parts: RawBuilder<boolean>[] = [];
  if (p.roles.includes('LAB')) parts.push(sql<boolean>`t.lab_org_id = ${p.orgId}`);
  if (isParticipant(p))
    parts.push(batchVisibleTo({ ...p, roles: p.roles.filter((r) => r !== 'LAB') }, sql.ref('t.batch_id')));
  return parts.length ? sql<boolean>`(${sql.join(parts, sql` OR `)})` : sql<boolean>`false`;
}

export interface LabTestListItem {
  id: string;
  batch: BatchListItem;
  lab: OrganizationRef;
  reason: string;
  status: string;
  conclusion: string | null;
  dueAt: string;
  overdue: boolean;
  createdAt: string;
  sampledAt: string | null;
  completedAt: string | null;
  hasProtocol: boolean;
}

export interface LabTestView extends LabTestListItem {
  escalatedAt: string | null;
  results: {
    indicatorId: string;
    name: string;
    unit: string;
    value: string;
    normValue: string;
    isExceeded: boolean;
  }[];
  protocol: FileRef | null;
  norms: { indicatorId: string; name: string; unit: string; maxValue: string }[];
  recallId: string | null;
  version: number;
  actions: string[];
}

function rowsQuery(q: Q, ids: readonly string[]) {
  return q
    .selectFrom('lab_tests as t')
    .innerJoin('batches as b', 'b.id', 't.batch_id')
    .leftJoin('files as f', (j) => j.onRef('f.id', '=', 't.protocol_file_id').on('f.deleted_at', 'is', null))
    .select([
      't.id',
      't.batch_id',
      't.lab_org_id',
      't.reason',
      't.status',
      't.conclusion',
      't.due_at',
      't.created_at',
      't.sampled_at',
      't.completed_at',
      't.escalated_at',
      't.recall_id',
      't.version',
      'b.product_id',
      'f.id as file_id',
      'f.kind as file_kind',
      'f.mime as file_mime',
      'f.size_bytes as file_size',
      'f.original_name as file_name',
      sql<boolean>`(t.status IN ('QUEUED', 'SAMPLED', 'ESCALATED') AND now() > t.due_at)`.as('overdue'),
    ])
    .where('t.id', 'in', [...ids]);
}

type Row = Awaited<ReturnType<ReturnType<typeof rowsQuery>['execute']>>[number];

async function items(q: Q, ids: readonly string[]): Promise<{ row: Row; item: LabTestListItem }[]> {
  if (ids.length === 0) return [];
  const rows = await rowsQuery(q, ids).execute();
  const batches = new Map(
    (
      await loadListItems(
        q,
        rows.map((r) => r.batch_id),
      )
    ).map((b) => [b.id, b]),
  );
  const labs = await orgRefs(
    q,
    rows.map((r) => r.lab_org_id),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        row: r,
        item: {
          id: r.id,
          batch: batches.get(r.batch_id)!,
          lab: labs.get(r.lab_org_id)!,
          reason: r.reason,
          status: r.status,
          conclusion: r.conclusion,
          dueAt: iso(r.due_at),
          overdue: r.overdue === true,
          createdAt: iso(r.created_at),
          sampledAt: isoOrNull(r.sampled_at),
          completedAt: isoOrNull(r.completed_at),
          hasProtocol: r.file_id !== null,
        },
      },
    ];
  });
}

/** LabTestListItem of `ids`, in the order of `ids`. */
export async function loadLabTestItems(q: Q, ids: readonly string[]): Promise<LabTestListItem[]> {
  return (await items(q, ids)).map((x) => x.item);
}

/** Current norms of a product (non-deleted indicators), by indicator name (code points), then id. */
export async function currentNorms(q: Q, productId: string) {
  const rows = await q
    .selectFrom('norms as n')
    .innerJoin('indicators as i', 'i.id', 'n.indicator_id')
    .select(['i.id', 'i.name', 'i.unit', 'n.max_value'])
    .where('n.product_id', '=', productId)
    .where('i.deleted_at', 'is', null)
    .orderBy(sql`i.name COLLATE "C"`)
    .orderBy(sql`i.id::text COLLATE "C"`)
    .execute();
  return rows.map((r) => ({ indicatorId: r.id, name: r.name, unit: r.unit, maxValue: r.max_value }));
}

/** The `LabTest` card of `id` for `p` (the caller checked visibility). */
export async function loadLabTest(q: Q, p: Principal, fileUrls: FileUrls, id: string): Promise<LabTestView> {
  const [{ row: r, item }] = (await items(q, [id])) as [{ row: Row; item: LabTestListItem }];
  const results =
    r.status === 'DONE'
      ? (
          await q
            .selectFrom('lab_results as lr')
            .innerJoin('indicators as i', 'i.id', 'lr.indicator_id')
            .select(['i.id', 'i.name', 'i.unit', 'lr.value', 'lr.norm_value_snapshot', 'lr.is_exceeded'])
            .where('lr.lab_test_id', '=', id)
            .orderBy(sql`i.name COLLATE "C"`)
            .orderBy(sql`i.id::text COLLATE "C"`)
            .execute()
        ).map((x) => ({
          indicatorId: x.id,
          name: x.name,
          unit: x.unit,
          value: x.value,
          normValue: x.norm_value_snapshot ?? x.value,
          isExceeded: x.is_exceeded,
        }))
      : [];
  const norms =
    r.status === 'DONE'
      ? results.map((x) => ({
          indicatorId: x.indicatorId,
          name: x.name,
          unit: x.unit,
          maxValue: x.normValue,
        }))
      : await currentNorms(q, r.product_id);
  // LabTestActionName: role LAB of the test's own laboratory (the operations answer 404 to any other).
  const actions: string[] = [];
  if (p.roles.includes('LAB') && r.lab_org_id === p.orgId) {
    if (r.status === 'QUEUED') actions.push('sample');
    if ((LAB_OPEN as readonly string[]).includes(r.status)) actions.push('submitResults');
    if (r.status !== 'CANCELLED') actions.push('uploadProtocol');
  }
  return {
    ...item,
    escalatedAt: isoOrNull(r.escalated_at),
    results,
    protocol:
      r.file_id === null
        ? null
        : fileRef(fileUrls, {
            id: r.file_id,
            kind: r.file_kind!,
            mime: r.file_mime!,
            size_bytes: r.file_size!,
            original_name: r.file_name!,
          }),
    norms,
    recallId: r.recall_id,
    version: r.version,
    actions,
  };
}
