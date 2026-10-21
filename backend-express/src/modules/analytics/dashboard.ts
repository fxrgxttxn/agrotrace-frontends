/**
 * getDashboard (contracts/openapi/paths/analytics.yaml; schemas InspectorDashboard, OrgDashboard, LabDashboard;
 * FR-ANL-01…03). `scope` by the caller's roles (union): inspector — INSPECTOR, ADMIN; org — FARMER, PROCESSOR,
 * RETAILER (the caller's organization); lab — LAB (the caller's laboratory); otherwise `errors.scope:
 * [validation.scope.notAllowed]` (R51), in the same 400 as the window's errors. Every number comes from one READ ONLY
 * REPEATABLE READ snapshot (window.ts); "now" is the snapshot's now(). Deleted rows never count (soft-deleted batches
 * hide their lab tests and recall tasks too); shares via `ratioPercent2`, hours via `Hours` (S whole seconds /
 * (N × 3600), half up).
 */
import { sql, type Transaction } from 'kysely';
import type { Request } from 'express';
import { ratioPercent2 } from '@agrotrace/domain';
import machine from '../../../../contracts/rules/state-machine.json' with { type: 'json' };
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { QueryReader } from '../../http/params.js';
import type { Principal } from '../../security/jwt.js';
import { orgRefs } from '../batches/view.js';
import { bounds, resolveWindow, snapshot, tooLong, type Window } from './window.js';

type Tx = Transaction<DB>;

const SCOPES = ['inspector', 'org', 'lab'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_ROLES: Record<Scope, readonly string[]> = {
  inspector: ['INSPECTOR', 'ADMIN'],
  org: ['FARMER', 'PROCESSOR', 'RETAILER'],
  lab: ['LAB'],
};

/** `Hours` of a sum of whole seconds over `n` records; null when there are none. */
export function hours(seconds: bigint | string | number, n: number): string | null {
  if (n === 0) return null;
  return ratioPercent2(BigInt(seconds), BigInt(n) * 360_000n);
}

interface ShareRow {
  key: string;
  name: string;
  tested: number;
  failed: number;
}

/** Top 10 by `share` desc, then `tested` desc, then `name` (code points). */
function topShares(rows: ShareRow[]) {
  return rows
    .map((r) => ({ ...r, share: ratioPercent2(BigInt(r.failed), BigInt(r.tested)) }))
    .sort(
      (a, b) =>
        Number(b.share) - Number(a.share) ||
        b.tested - a.tested ||
        (Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) as number),
    )
    .slice(0, 10)
    .map(({ key, name, tested, failed, share }) => ({ key, name, tested, failed, share }));
}

/** DONE tests completed in the window, of non-deleted tests of non-deleted batches. */
const DONE_IN = (w: { start: Date; end: Date }) => sql`
  lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE'
  AND lt.completed_at >= ${w.start} AND lt.completed_at < ${w.end}`;

async function inspectorDashboard(tx: Tx, w: Window) {
  const b = bounds(w);
  const total = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM batches
     WHERE deleted_at IS NULL AND created_at >= ${b.start} AND created_at < ${b.end}`.execute(tx);
  const byProduct = await sql<ShareRow>`
    SELECT p.id AS key, p.name, count(*)::int AS tested, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
      FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id
     WHERE ${DONE_IN(b)}
     GROUP BY p.id, p.name`.execute(tx);
  const byFarm = await sql<ShareRow>`
    SELECT o.id AS key, o.name, count(*)::int AS tested, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
      FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id
     WHERE ${DONE_IN(b)} AND b.kind = 'RAW' AND o.type = 'FARM'
     GROUP BY o.id, o.name`.execute(tx);
  const active = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM recalls WHERE deleted_at IS NULL AND status = 'OPEN'`.execute(tx);
  const closed = await sql<{ s: string; n: number }>`
    SELECT coalesce(sum(floor(extract(epoch FROM closed_at - opened_at)))::bigint, 0)::text AS s, count(*)::int AS n
      FROM recalls
     WHERE deleted_at IS NULL AND closed_at >= ${b.start} AND closed_at < ${b.end}`.execute(tx);
  const regions = await sql<{ code: string; name: string; count: number }>`
    SELECT r.code, r.name,
           (SELECT count(*)::int FROM lab_tests lt
              JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id
             WHERE ${DONE_IN(b)} AND lt.conclusion = 'FAIL' AND o.region_id = r.id) AS count
      FROM regions r
     ORDER BY r.code COLLATE "C"`.execute(tx);
  return {
    scope: 'inspector' as const,
    period: w,
    batchesTotal: total.rows[0]!.n,
    rejectedShare: { byProduct: topShares(byProduct.rows), byFarm: topShares(byFarm.rows) },
    activeRecalls: active.rows[0]!.n,
    avgRecallHours: hours(closed.rows[0]!.s, closed.rows[0]!.n),
    violationsByRegion: regions.rows,
  };
}

async function orgDashboard(tx: Tx, p: Principal, w: Window) {
  const b = bounds(w);
  const held = await sql<{ status: string; n: number }>`
    SELECT status, count(*)::int AS n FROM batches
     WHERE deleted_at IS NULL AND holder_org_id = ${p.orgId}
     GROUP BY status`.execute(tx);
  const counts = new Map(held.rows.map((r) => [r.status, r.n]));
  const lab = await sql<{ pass: number; fail: number }>`
    SELECT count(*) FILTER (WHERE lt.conclusion = 'PASS')::int AS pass,
           count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS fail
      FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
     WHERE ${DONE_IN(b)} AND b.origin_org_id = ${p.orgId}`.execute(tx);
  // Tasks as listRecallTasks shows them: tasks of deleted recalls or deleted batches are not counted.
  const tasks = await sql<{ open: number; overdue: number }>`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE now() > t.due_at)::int AS overdue
      FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id
     WHERE t.holder_org_id = ${p.orgId} AND t.status IN ('OPEN', 'OVERDUE')
       AND r.deleted_at IS NULL AND b.deleted_at IS NULL`.execute(tx);
  return {
    scope: 'org' as const,
    period: w,
    organization: (await orgRefs(tx, [p.orgId])).get(p.orgId)!,
    byStatus: machine.statuses.map((status) => ({ status, count: counts.get(status) ?? 0 })),
    labResults: lab.rows[0]!,
    openTasks: tasks.rows[0]!.open,
    overdueTasks: tasks.rows[0]!.overdue,
  };
}

async function labDashboard(tx: Tx, p: Principal, w: Window) {
  const b = bounds(w);
  const queue = await sql<{ n: number; overdue: number }>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE now() > lt.due_at)::int AS overdue
      FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
     WHERE lt.lab_org_id = ${p.orgId} AND lt.deleted_at IS NULL AND b.deleted_at IS NULL
       AND lt.status IN ('QUEUED', 'SAMPLED', 'ESCALATED')`.execute(tx);
  const done = await sql<{ n: number; failed: number; s: string }>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed,
           coalesce(sum(floor(extract(epoch FROM lt.completed_at - lt.created_at)))::bigint, 0)::text AS s
      FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
     WHERE ${DONE_IN(b)} AND lt.lab_org_id = ${p.orgId}`.execute(tx);
  const d = done.rows[0]!;
  return {
    scope: 'lab' as const,
    period: w,
    organization: (await orgRefs(tx, [p.orgId])).get(p.orgId)!,
    queue: queue.rows[0]!.n,
    overdue: queue.rows[0]!.overdue,
    completed: d.n,
    failed: d.failed,
    avgHours: hours(d.s, d.n),
  };
}

export function dashboardService(c: Container) {
  return {
    async get(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const scope = q.enumOf('scope', SCOPES);
      if (!q.has('scope')) q.errors.scope = ['validation.required'];
      if (scope && !p.roles.some((r) => SCOPE_ROLES[scope].includes(r)))
        q.errors.scope = ['validation.scope.notAllowed'];
      const { from, to } = q.dateRange();
      if (!q.errors.from && tooLong(from, to)) q.errors.from = ['validation.range.tooLong'];
      q.done();
      return snapshot(c.db, async (tx, now) => {
        const w = resolveWindow(from, to, now.toISOString().slice(0, 10));
        if (scope === 'inspector') return inspectorDashboard(tx, w);
        if (scope === 'org') return orgDashboard(tx, p, w);
        return labDashboard(tx, p, w);
      });
    },
  };
}
