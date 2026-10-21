/**
 * Dashboards GET /analytics/dashboard (contracts/openapi/paths/analytics.yaml; schemas InspectorDashboard,
 * OrgDashboard, LabDashboard; FR-ANL-01…03). Scope by roles (R51), the window (30-day default, 366-day maximum), and
 * every number of the schema descriptions: expected values are computed here by read-only SQL over the shared DB (or
 * built from scratch with a fresh farm), so the suite holds on any backend. The DB changes while the suite runs (the
 * scheduler ticks every second), so a comparison is made only when the SQL gives the same answer before and after
 * the request (`stable`).
 */
import { describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { dbNow, query } from './lib/db.js';
import { expectErrors } from './lib/expect.js';
import { freshOrg, sentWaybill, acceptWaybill } from './lib/production.js';
import {
  createRecall,
  freshFarm,
  inspector,
  inspectorTest,
  rawBatch,
  submitAll,
  vetlab,
} from './lib/quality.js';

const STATUSES = [
  'Created',
  'OnTest',
  'Approved',
  'InTransit',
  'Accepted',
  'Processed',
  'OnSale',
  'Sold',
  'Blocked',
  'Recalled',
  'WrittenOff',
];

const DAY = 86_400_000;
const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const today = async () => (await dbNow()).toISOString().slice(0, 10);
const bounds = (from: string, to: string) => [`${from}T00:00:00Z`, `${shift(to, 1)}T00:00:00Z`];

async function dashboard(client: ApiClient, q: Record<string, string>) {
  const res = await client.get('/analytics/dashboard', { query: q });
  await expectContract(res, 'getDashboard');
  return res;
}

/** ratioPercent2 (half up, two decimals) for non-negative integers. */
const ratio2 = (n: bigint, d: bigint): string => {
  const scaled = (n * 10000n * 2n + d) / (2n * d);
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
};
const hoursOf = (s: bigint, n: number): string | null => (n === 0 ? null : ratio2(s, BigInt(n) * 360000n));
const byCodePoints = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Compares the response with the SQL expectation once the expectation is stable across the request. */
async function stable<T>(expected: () => Promise<T>, actual: () => Promise<unknown>): Promise<void> {
  for (let i = 0; ; i++) {
    const before = await expected();
    const got = await actual();
    const after = await expected();
    if (JSON.stringify(before) === JSON.stringify(after) || i === 4) {
      expect(got).toEqual(after);
      return;
    }
  }
}

// ── expectations (read-only SQL) ───────────────────────────────────────────────────────────────────────────────

const DONE = `lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE'
              AND lt.completed_at >= $1 AND lt.completed_at < $2`;

async function expectedInspector(from: string, to: string) {
  const [s, e] = bounds(from, to);
  const [total] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM batches WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2`,
    [s, e],
  );
  const shares = async (sqlText: string) =>
    (await query<{ key: string; name: string; tested: number; failed: number }>(sqlText, [s, e]))
      .map((r) => ({ ...r, share: ratio2(BigInt(r.failed), BigInt(r.tested)) }))
      .sort(
        (a, b) => Number(b.share) - Number(a.share) || b.tested - a.tested || byCodePoints(a.name, b.name),
      )
      .slice(0, 10);
  const byProduct = await shares(
    `SELECT p.id AS key, p.name, count(*)::int AS tested, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
       FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id
      WHERE ${DONE} GROUP BY p.id, p.name`,
  );
  const byFarm = await shares(
    `SELECT o.id AS key, o.name, count(*)::int AS tested, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed
       FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN organizations o ON o.id = b.origin_org_id
      WHERE ${DONE} AND b.kind = 'RAW' AND o.type = 'FARM' GROUP BY o.id, o.name`,
  );
  const [active] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM recalls WHERE deleted_at IS NULL AND status = 'OPEN'`,
  );
  const [closed] = await query<{ s: string; n: number }>(
    `SELECT coalesce(sum(floor(extract(epoch FROM closed_at - opened_at))), 0)::bigint::text AS s, count(*)::int AS n
       FROM recalls WHERE deleted_at IS NULL AND closed_at >= $1 AND closed_at < $2`,
    [s, e],
  );
  const regions = await query<{ code: string; name: string; count: number }>(
    `SELECT r.code, r.name, count(t.id)::int AS count
       FROM regions r
       LEFT JOIN (SELECT lt.id, o.region_id FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
                    JOIN organizations o ON o.id = b.origin_org_id
                   WHERE ${DONE} AND lt.conclusion = 'FAIL') t ON t.region_id = r.id
      GROUP BY r.id, r.code, r.name ORDER BY r.code COLLATE "C"`,
    [s, e],
  );
  return {
    scope: 'inspector',
    period: { from, to },
    batchesTotal: total!.n,
    rejectedShare: { byProduct, byFarm },
    activeRecalls: active!.n,
    avgRecallHours: hoursOf(BigInt(closed!.s), closed!.n),
    violationsByRegion: regions,
  };
}

async function orgRefOf(orgId: string) {
  const [o] = await query<{ id: string; name: string; type: string; logo: string | null }>(
    `SELECT id, name, type, logo_file_id AS logo FROM organizations WHERE id = $1`,
    [orgId],
  );
  return {
    id: o!.id,
    name: o!.name,
    type: o!.type,
    logoUrl: o!.logo ? `/api/v1/public/files/${o!.logo}` : null,
  };
}

async function expectedOrg(orgId: string, from: string, to: string) {
  const [s, e] = bounds(from, to);
  const held = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM batches WHERE deleted_at IS NULL AND holder_org_id = $1 GROUP BY status`,
    [orgId],
  );
  const [lab] = await query<{ pass: number; fail: number }>(
    `SELECT count(*) FILTER (WHERE lt.conclusion = 'PASS')::int AS pass, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS fail
       FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id WHERE ${DONE} AND b.origin_org_id = $3`,
    [s, e, orgId],
  );
  const [tasks] = await query<{ open: number; overdue: number }>(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE now() > t.due_at)::int AS overdue
       FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id JOIN batches b ON b.id = t.batch_id
      WHERE t.holder_org_id = $1 AND t.status IN ('OPEN', 'OVERDUE') AND r.deleted_at IS NULL AND b.deleted_at IS NULL`,
    [orgId],
  );
  return {
    scope: 'org',
    period: { from, to },
    organization: await orgRefOf(orgId),
    byStatus: STATUSES.map((status) => ({ status, count: held.find((h) => h.status === status)?.n ?? 0 })),
    labResults: lab,
    openTasks: tasks!.open,
    overdueTasks: tasks!.overdue,
  };
}

async function expectedLab(orgId: string, from: string, to: string) {
  const [s, e] = bounds(from, to);
  const [queue] = await query<{ n: number; overdue: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE now() > lt.due_at)::int AS overdue
       FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
      WHERE lt.lab_org_id = $1 AND lt.deleted_at IS NULL AND b.deleted_at IS NULL
        AND lt.status IN ('QUEUED', 'SAMPLED', 'ESCALATED')`,
    [orgId],
  );
  const [done] = await query<{ n: number; failed: number; s: string }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE lt.conclusion = 'FAIL')::int AS failed,
            coalesce(sum(floor(extract(epoch FROM lt.completed_at - lt.created_at))), 0)::bigint::text AS s
       FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id WHERE ${DONE} AND lt.lab_org_id = $3`,
    [s, e, orgId],
  );
  return {
    scope: 'lab',
    period: { from, to },
    organization: await orgRefOf(orgId),
    queue: queue!.n,
    overdue: queue!.overdue,
    completed: done!.n,
    failed: done!.failed,
    avgHours: hoursOf(BigInt(done!.s), done!.n),
  };
}

const orgOf = async (client: ApiClient): Promise<string> => {
  const me = await client.get('/me');
  await expectContract(me, 'getMe');
  return me.body.organization.id as string;
};

// ── tests ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('getDashboard: scope and window', () => {
  it('scopes by role (union of roles): inspector — INSPECTOR, ADMIN; org — FARMER, PROCESSOR, RETAILER; lab — LAB', async () => {
    const allowed: Record<Role, string> = {
      INSPECTOR: 'inspector',
      ADMIN: 'inspector',
      FARMER: 'org',
      PROCESSOR: 'org',
      RETAILER: 'org',
      LAB: 'lab',
    };
    for (const [role, scope] of Object.entries(allowed) as [Role, string][]) {
      const client = await loginAs(role);
      const ok = await dashboard(client, { scope });
      expect(ok.status, `${role} ${scope}: ${ok.text}`).toBe(200);
      expect(ok.body.scope).toBe(scope);
      for (const other of ['inspector', 'org', 'lab'].filter((s) => s !== scope))
        expectErrors(await dashboard(client, { scope: other }), { scope: ['validation.scope.notAllowed'] });
    }
    const insp = await inspector();
    expectErrors(await dashboard(insp, {}), { scope: ['validation.required'] });
    expectErrors(await dashboard(insp, { scope: 'all' }), { scope: ['validation.enum'] });
    expect((await dashboard(api(), { scope: 'inspector' })).status).toBe(401);
  });

  it('window: default last 30 days (UTC), one end → 30 days from it, from > to → range, > 366 days → range.tooLong', async () => {
    const insp = await inspector();
    const t = await today();
    expect((await dashboard(insp, { scope: 'inspector' })).body.period).toEqual({
      from: shift(t, -29),
      to: t,
    });
    expect((await dashboard(insp, { scope: 'inspector', from: '2026-03-01' })).body.period).toEqual({
      from: '2026-03-01',
      to: '2026-03-30',
    });
    expect((await dashboard(insp, { scope: 'inspector', to: '2026-03-01' })).body.period).toEqual({
      from: '2026-01-31',
      to: '2026-03-01',
    });
    const max = await dashboard(insp, { scope: 'inspector', from: '2025-03-01', to: '2026-03-01' });
    expect(max.status, max.text).toBe(200); // 366 days (2025-03-01 … 2026-03-01)
    expectErrors(await dashboard(insp, { scope: 'inspector', from: '2025-02-28', to: '2026-03-01' }), {
      from: ['validation.range.tooLong'],
    });
    expectErrors(await dashboard(insp, { scope: 'inspector', from: '2026-03-02', to: '2026-03-01' }), {
      from: ['validation.range'],
    });
    expectErrors(await dashboard(insp, { scope: 'lab', from: '2026-02-30' }), {
      scope: ['validation.scope.notAllowed'],
      from: ['validation.date.format'],
    });
  });
});

describe('getDashboard: numbers', () => {
  it('inspector: batchesTotal, rejectedShare by product / farm, activeRecalls, avgRecallHours, violationsByRegion', async () => {
    const insp = await inspector();
    const t = await today();
    for (const [from, to] of [
      [shift(t, -29), t],
      [shift(t, -365), t],
    ] as const) {
      await stable(
        () => expectedInspector(from, to),
        async () => {
          const res = await dashboard(insp, { scope: 'inspector', from, to });
          expect(res.status, res.text).toBe(200);
          return res.body;
        },
      );
    }
    const wide = (await dashboard(insp, { scope: 'inspector', from: shift(t, -365), to: t })).body;
    expect(wide.batchesTotal).toBeGreaterThan(0);
    expect(wide.violationsByRegion.length).toBe(
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM regions`))[0]!.n,
    );
  });

  it('org: a fresh farm from scratch (byStatus, labResults, open/overdue tasks); seeded organizations by SQL', async () => {
    const farm = await freshFarm();
    const t = await today();
    const fresh = await dashboard(farm.client, { scope: 'org' });
    expect(fresh.body).toEqual({
      scope: 'org',
      period: { from: shift(t, -29), to: t },
      organization: await orgRefOf(farm.orgId),
      byStatus: STATUSES.map((status) => ({ status, count: 0 })),
      labResults: { pass: 0, fail: 0 },
      openTasks: 0,
      overdueTasks: 0,
    });
    const b1 = await rawBatch(farm); // OnTest (new farm)
    await submitAll(await inspectorTest(b1.id), '0'); // PASS → Approved
    const b2 = await rawBatch(farm);
    const processor = await freshOrg('PROCESSOR');
    const wb = await sentWaybill(farm.client, processor.orgId, [b1]);
    const recall = await createRecall(await inspector(), {
      sourceBatchId: b2.id,
      reason: 'Дашборд',
      blockUpstream: false,
    });
    expect(recall.status, recall.text).toBe(201);
    const counts = (d: { byStatus: { status: string; count: number }[] }) =>
      Object.fromEntries(d.byStatus.filter((s) => s.count > 0).map((s) => [s.status, s.count]));
    const after = (await dashboard(farm.client, { scope: 'org' })).body;
    // The holder changes on acceptance: while InTransit, b1 is still the farm's.
    expect(counts(after)).toEqual({ InTransit: 1, Recalled: 1 });
    expect(after.labResults).toEqual({ pass: 1, fail: 0 });
    expect(after.openTasks).toBe(1);
    expect(after.overdueTasks).toBe(0);
    const acc = await acceptWaybill(processor.client, wb, [{ batchId: b1.id, massActualKg: b1.massKg }]);
    expect(acc.status, acc.text).toBe(200);
    expect(counts((await dashboard(processor.client, { scope: 'org' })).body)).toEqual({ Accepted: 1 });
    expect(counts((await dashboard(farm.client, { scope: 'org' })).body)).toEqual({ Recalled: 1 });

    for (const key of ['petrov', 'molkombinat.head', 'provizia.head']) {
      const user = await loginAs(
        key === 'petrov' ? 'FARMER' : key.startsWith('mol') ? 'PROCESSOR' : 'RETAILER',
        { key },
      );
      const orgId = await orgOf(user);
      await stable(
        () => expectedOrg(orgId, shift(t, -365), t),
        async () => (await dashboard(user, { scope: 'org', from: shift(t, -365), to: t })).body,
      );
    }
  });

  it('lab: queue / overdue at request time, completed / failed / avgHours in the window', async () => {
    const lab = await vetlab();
    const t = await today();
    for (const [from, to] of [
      [shift(t, -29), t],
      [shift(t, -365), t],
    ] as const)
      await stable(
        () => expectedLab(lab.orgId, from, to),
        async () => (await dashboard(lab.client, { scope: 'lab', from, to })).body,
      );
    const before = (await dashboard(lab.client, { scope: 'lab' })).body;
    const farm = await freshFarm();
    const test = await inspectorTest((await rawBatch(farm)).id);
    const queued = (await dashboard(lab.client, { scope: 'lab' })).body;
    expect(queued.queue).toBeGreaterThanOrEqual(before.queue + 1);
    await submitAll(test, '0');
    const done = (await dashboard(lab.client, { scope: 'lab' })).body;
    expect(done.completed).toBeGreaterThanOrEqual(before.completed + 1);
    expect(done.avgHours).toMatch(/^\d{1,9}\.\d{2}$/);
  });
});
