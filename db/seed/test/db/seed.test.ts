/**
 * Checks the seeded dev database and MinIO (`./at.sh seed:test`; global-setup.ts seeds first with SEED_NOW).
 * Every check re-derives the expected value from the rows with @agrotrace/domain or raw SQL,
 * independently of the simulator that produced them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  addWorkingDays,
  canTransition,
  checkDiscrepancy,
  checkMassBalance,
  compareDecimalStrings,
  concludeLabTest,
  nextTrustRating,
  recallTaskDueAt,
  shouldCloseRecall,
  type BatchStatus,
} from '@agrotrace/domain';
import argon2 from 'argon2';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import entityMachines from '../../../../contracts/rules/entity-state-machines.json' with { type: 'json' };
import waybillMachine from '../../../../contracts/rules/waybill-state-machine.json' with { type: 'json' };
import notificationRules from '../../../../contracts/rules/notifications.json' with { type: 'json' };
import { DEMO_PASSWORD, loadData, SEED_ROOT } from '../../src/data';
import { REFERENCE_NOW } from '../../src/time';
import { s3Client } from '../../src/seed';
import { env } from './db';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const iso = (d: unknown): string => new Date(d as string).toISOString().replace('.000Z', 'Z');
const data = loadData();
/** SEED_NOW the global setup seeded with (every seeded moment is at or before it). */
const NOW = inject('seedNow');
const YEAR = NOW.slice(0, 4);
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<R[]> => (await db.query(sql, params)).rows;

beforeAll(async () => {
  db = new pg.Client({ connectionString: env.databaseUrl });
  await db.connect();
});
afterAll(() => db.end());

/** Batch status at moment t (last history row at or before t). */
async function statusAt(batchId: string, t: unknown): Promise<string> {
  const [h] = await q(
    'SELECT to_status FROM batch_status_history WHERE batch_id = $1 AND changed_at <= $2 ORDER BY changed_at DESC, id DESC LIMIT 1',
    [batchId, t],
  );
  return h!.to_status;
}

/** Holder at moment t: receiver of the last waybill with the batch accepted at or before t, else the origin. */
async function holderAt(batchId: string, t: unknown): Promise<string> {
  const [w] = await q(
    `SELECT w.receiver_org_id FROM waybills w JOIN waybill_items i ON i.waybill_id = w.id
      WHERE i.batch_id = $1 AND w.status = 'ACCEPTED' AND w.accepted_at <= $2 ORDER BY w.accepted_at DESC LIMIT 1`,
    [batchId, t],
  );
  if (w) return w.receiver_org_id;
  const [b] = await q('SELECT origin_org_id FROM batches WHERE id = $1', [batchId]);
  return b!.origin_org_id;
}

describe('composition (spec §7.8)', () => {
  it('has the dictionaries: 15 products with photos, 20 substances, 12 indicators, 3–5 norms per product', async () => {
    const products = await q('SELECT * FROM products');
    expect(products).toHaveLength(15);
    expect(products.every((p) => p.image_file_id)).toBe(true);
    expect(await q('SELECT 1 FROM substances')).toHaveLength(20);
    expect(await q('SELECT 1 FROM indicators')).toHaveLength(12);
    const perProduct = await q(
      'SELECT p.name, count(n.id)::int AS n FROM products p LEFT JOIN norms n ON n.product_id = p.id GROUP BY p.name',
    );
    for (const r of perProduct) expect(r.n, r.name).toBeGreaterThanOrEqual(3);
    for (const r of perProduct) expect(r.n, r.name).toBeLessThanOrEqual(5);
    expect(
      await q(
        'SELECT 1 FROM indicators i WHERE NOT EXISTS (SELECT 1 FROM norms n WHERE n.indicator_id = i.id)',
      ),
    ).toHaveLength(0);
  });

  it('has 12 active organizations of every type, each with a logo; FARM INNs of the Mercury emulator', async () => {
    const orgs = await q(
      'SELECT type, count(*)::int AS n FROM organizations WHERE status = $1 AND logo_file_id IS NOT NULL GROUP BY type',
      ['ACTIVE'],
    );
    expect(Object.fromEntries(orgs.map((o) => [o.type, o.n]))).toEqual({
      FARM: 3,
      PROCESSOR: 2,
      LAB: 2,
      RETAILER: 3,
      AUTHORITY: 1,
      PLATFORM: 1,
    });
    const inns = (await q('SELECT inn FROM organizations')).map((o) => o.inn);
    for (const inn of ['2312450016', '502701234075', '7806540043', '7705120028', '231099887716'])
      expect(inns).toContain(inn);
  });

  it('has an employee and a head for every role, every organization has an active head, emails are lowercase', async () => {
    const users = await q(
      `SELECT u.email, u.is_org_admin, u.status, r.code FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id`,
    );
    expect(users).toHaveLength(data.users.length);
    for (const role of ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN']) {
      expect(
        users.filter((u) => u.code === role && u.is_org_admin),
        role,
      ).not.toHaveLength(0);
      expect(
        users.filter((u) => u.code === role && !u.is_org_admin),
        role,
      ).not.toHaveLength(0);
    }
    expect(users.every((u) => u.status === 'ACTIVE' && u.email === u.email.toLowerCase())).toBe(true);
    expect(
      await q(
        'SELECT 1 FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.is_org_admin)',
      ),
    ).toHaveLength(0);
    expect(await q('SELECT 1 FROM users WHERE avatar_file_id IS NOT NULL')).toHaveLength(6);
  });

  it('has 6 fields with closed GeoJSON polygons in Владимирская область and treatments', async () => {
    const fields = await q(`SELECT f.*, r.code FROM fields f JOIN regions r ON r.id = f.region_id`);
    expect(fields).toHaveLength(6);
    for (const f of fields) {
      expect(f.code).toBe('33');
      expect(f.geometry.type).toBe('Polygon');
      const ring = f.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThan(38.2);
        expect(lon).toBeLessThan(43.0);
        expect(lat).toBeGreaterThan(55.0);
        expect(lat).toBeLessThan(57.0);
      }
    }
    expect((await q('SELECT 1 FROM treatments')).length).toBeGreaterThanOrEqual(10);
  });

  it('has 41 batches with codes AT-2026-000001…41 and a graph of depth 4; the sequences continue after them', async () => {
    const codes = (await q('SELECT public_code FROM batches ORDER BY public_code')).map((b) => b.public_code);
    expect(codes).toEqual(
      Array.from({ length: 41 }, (_, i) => `AT-${YEAR}-${String(i + 1).padStart(6, '0')}`),
    );
    const [depth] = await q(`
      WITH RECURSIVE down AS (
        SELECT l.child_batch_id AS id, 1 AS depth FROM batch_links l
          WHERE NOT EXISTS (SELECT 1 FROM batch_links p WHERE p.child_batch_id = l.parent_batch_id)
        UNION ALL SELECT l.child_batch_id, d.depth + 1 FROM batch_links l JOIN down d ON l.parent_batch_id = d.id WHERE d.depth < 20)
      SELECT max(depth)::int AS max FROM down`);
    expect(depth!.max).toBe(4);
    const [seq] = await q('SELECT last_value::int AS v, is_called FROM batch_code_seq');
    expect(seq).toEqual({ v: 41, is_called: true });
    const [wseq] = await q('SELECT last_value::int AS v FROM waybill_number_seq');
    const [{ n }] = (await q('SELECT count(*)::int AS n FROM waybills')) as [R];
    expect(wseq!.v).toBe(n);
  });

  it('covers every waybill status, lab results incl. two FAILs, a closed and open recalls, complaints of every status', async () => {
    const wb = (await q('SELECT DISTINCT status FROM waybills')).map((r) => r.status).sort();
    expect(wb).toEqual(['ACCEPTED', 'DRAFT', 'REJECTED', 'SENT']);
    expect(await q(`SELECT 1 FROM lab_tests WHERE conclusion = 'FAIL'`)).toHaveLength(2);
    const labStatuses = (await q('SELECT DISTINCT status FROM lab_tests')).map((r) => r.status).sort();
    expect(labStatuses).toEqual(['DONE', 'ESCALATED', 'QUEUED', 'SAMPLED']);
    const recalls = await q('SELECT * FROM recalls ORDER BY opened_at');
    expect(recalls.map((r) => `${r.status} ${r.trigger}`)).toEqual([
      'CLOSED COMPLAINT',
      'OPEN LAB',
      'OPEN LAB',
      'OPEN INSPECTOR',
    ]);
    const taskStatuses = async (r: R): Promise<string[]> =>
      (await q('SELECT DISTINCT status FROM recall_tasks WHERE recall_id = $1', [r.id]))
        .map((x) => x.status)
        .sort();
    // R75: the old LAB recall has confirmed and already escalated tasks, the fresh one open tasks.
    expect(await taskStatuses(recalls[1]!)).toEqual(['CONFIRMED', 'OVERDUE']);
    expect(await taskStatuses(recalls[2]!)).toEqual(['OPEN']); // R88 M8: the barley FAIL, 16 h old
    expect(await taskStatuses(recalls[3]!)).toEqual(['OPEN']);
    expect(Date.parse(NOW) - Date.parse(recalls[1]!.opened_at)).toBeGreaterThan(24 * 3_600_000);
    expect(Date.parse(NOW) - Date.parse(recalls[2]!.opened_at)).toBe(16 * 3_600_000);
    expect(Date.parse(NOW) - Date.parse(recalls[3]!.opened_at)).toBe(2 * 3_600_000);
    expect(recalls[3]!.block_upstream).toBe(true);
    const complaints = (await q('SELECT DISTINCT status FROM complaints')).map((r) => r.status).sort();
    expect(complaints).toEqual(['DECIDED', 'IN_REVIEW', 'NEW']);
    expect((await q('SELECT 1 FROM notifications')).length).toBeGreaterThan(0);
  });

  it('writes audit rows only as backend seed, and nothing is dated after SEED_NOW', async () => {
    expect(await q(`SELECT 1 FROM audit_log WHERE backend <> 'seed'`)).toHaveLength(0);
    expect((await q('SELECT 1 FROM audit_log')).length).toBeGreaterThan(100);
    for (const [table, col] of [
      ['batches', 'updated_at'],
      ['batch_status_history', 'changed_at'],
      ['notifications', 'created_at'],
      ['audit_log', 'created_at'],
      ['recall_tasks', 'updated_at'],
      ['lab_tests', 'updated_at'],
      ['organizations', 'updated_at'],
    ]) {
      expect(await q(`SELECT 1 FROM ${table} WHERE ${col} > $1`, [NOW]), table).toHaveLength(0);
    }
  });
});

describe('batches', () => {
  it('every history passes the state machine and ends in the batch status; version = number of transitions', async () => {
    const batches = await q('SELECT id, public_code, status, version FROM batches');
    expect(batches).toHaveLength(41);
    const history = await q('SELECT * FROM batch_status_history ORDER BY id');
    for (const b of batches) {
      const h = history.filter((x) => x.batch_id === b.id);
      expect(h[0], b.public_code).toMatchObject({
        from_status: null,
        to_status: 'Created',
        reason: 'CREATED',
      });
      for (let i = 1; i < h.length; i++) {
        expect(h[i]!.from_status, b.public_code).toBe(h[i - 1]!.to_status);
        expect(
          canTransition({ from: h[i]!.from_status as BatchStatus, to: h[i]!.to_status as BatchStatus })
            .allowed,
          b.public_code,
        ).toBe(true);
        expect(Date.parse(h[i]!.changed_at)).toBeGreaterThanOrEqual(Date.parse(h[i - 1]!.changed_at));
      }
      expect(h[h.length - 1]!.to_status, b.public_code).toBe(b.status);
      expect(b.version, b.public_code).toBe(h.length);
    }
  });

  it('every processing operation satisfies the mass balance (BR-04) and used only admitted inputs (BR-05)', async () => {
    const derived = await q(
      `SELECT id, origin_org_id, produced_at, mass_kg FROM batches WHERE kind = 'DERIVED'`,
    );
    const ops = new Map<string, R[]>();
    for (const d of derived)
      ops.set(`${d.origin_org_id}|${iso(d.produced_at)}`, [
        ...(ops.get(`${d.origin_org_id}|${iso(d.produced_at)}`) ?? []),
        d,
      ]);
    expect(ops.size).toBeGreaterThan(5);
    for (const outputs of ops.values()) {
      const links = await q(
        `SELECT DISTINCT l.parent_batch_id, l.mass_used_kg, p.mass_kg, pr.loss_norm_percent, p.id
           FROM batch_links l JOIN batches p ON p.id = l.parent_batch_id JOIN products pr ON pr.id = p.product_id
          WHERE l.child_batch_id = ANY($1)`,
        [outputs.map((o) => o.id)],
      );
      for (const o of outputs) {
        const parents = await q('SELECT parent_batch_id FROM batch_links WHERE child_batch_id = $1', [o.id]);
        expect(parents.map((p) => p.parent_batch_id).sort()).toEqual(
          [...new Set(links.map((l) => l.parent_batch_id))].sort(),
        );
      }
      const balance = checkMassBalance({
        inputs: links.map((l) => ({ massUsedKg: l.mass_used_kg, lossNormPercent: l.loss_norm_percent })),
        outputs: outputs.map((o) => ({ massKg: o.mass_kg })),
      });
      expect(balance).toMatchObject({ ok: true });
      for (const l of links) {
        expect(compareDecimalStrings(l.mass_used_kg, l.mass_kg)).toBeLessThanOrEqual(0);
        // status of the input just before its PROCESSED transition
        const [h] = await q(
          `SELECT from_status FROM batch_status_history WHERE batch_id = $1 AND reason = 'PROCESSED'`,
          [l.id],
        );
        expect(['Approved', 'Accepted']).toContain(h!.from_status);
      }
    }
  });

  it('derived batches have no field and no test; raw ones have their farm field', async () => {
    expect(await q(`SELECT 1 FROM batches WHERE kind = 'DERIVED'`)).toHaveLength(18);
    expect(
      await q(
        `SELECT 1 FROM batches WHERE kind = 'DERIVED' AND (field_id IS NOT NULL OR test_required OR test_reason <> 'NONE')`,
      ),
    ).toHaveLength(0);
    expect(
      await q(
        `SELECT 1 FROM batches b JOIN fields f ON f.id = b.field_id WHERE b.kind = 'RAW' AND f.organization_id <> b.origin_org_id`,
      ),
    ).toHaveLength(0);
    expect(await q(`SELECT 1 FROM batches WHERE kind = 'RAW' AND field_id IS NULL`)).toHaveLength(0);
  });

  it('QR was generated only by the holder in a status that allows it (R43, R44)', async () => {
    const withQr = await q(`
      SELECT b.id, b.public_code, b.kind, b.origin_org_id, b.qr_generated_at, png.kind AS png_kind, pdf.kind AS pdf_kind,
             png.original_name AS png_name, pdf.original_name AS pdf_name, png.owner_id, png.mime AS png_mime, pdf.mime AS pdf_mime
        FROM batches b JOIN files png ON png.id = b.qr_png_file_id JOIN files pdf ON pdf.id = b.qr_pdf_file_id`);
    expect(withQr.length).toBeGreaterThanOrEqual(5);
    let processorOwn = 0;
    for (const b of withQr) {
      expect([b.png_kind, b.pdf_kind, b.png_mime, b.pdf_mime]).toEqual([
        'QR',
        'QR',
        'image/png',
        'application/pdf',
      ]);
      expect([b.png_name, b.pdf_name]).toEqual([`${b.public_code}.png`, `${b.public_code}.pdf`]);
      const statusThen = await statusAt(b.id, b.qr_generated_at);
      const holderThen = await holderAt(b.id, b.qr_generated_at);
      const [holder] = await q('SELECT type FROM organizations WHERE id = $1', [holderThen]);
      const [owner] = await q(
        `SELECT u.organization_id, r.code FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.id = $1`,
        [b.owner_id],
      );
      expect(owner!.organization_id, b.public_code).toBe(holderThen); // generated by the holder (NOT_HOLDER otherwise)
      expect(['PROCESSOR', 'RETAILER']).toContain(owner!.code);
      const allowed =
        (['Accepted', 'OnSale'].includes(statusThen) && ['PROCESSOR', 'RETAILER'].includes(holder!.type)) ||
        (statusThen === 'Approved' &&
          b.kind === 'DERIVED' &&
          b.origin_org_id === holderThen &&
          owner!.code === 'PROCESSOR');
      expect(allowed, `${b.public_code}: ${statusThen} at ${holder!.type}`).toBe(true);
      if (statusThen === 'Approved') processorOwn++;
    }
    expect(processorOwn).toBeGreaterThan(0);
  });
});

describe('Blocked by the lab (R88 M8)', () => {
  it('a raw batch that failed its lab test before any processing went OnTest → Blocked (LAB_FAIL) → Recalled', async () => {
    const rows = await q(
      `SELECT b.id, b.public_code, b.status, b.kind FROM batches b
        WHERE EXISTS (SELECT 1 FROM batch_status_history h WHERE h.batch_id = b.id AND h.to_status = 'Blocked')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const b of rows) {
      const h = await q(
        'SELECT from_status, to_status, reason FROM batch_status_history WHERE batch_id = $1 ORDER BY id',
        [b.id],
      );
      const i = h.findIndex((x) => x.to_status === 'Blocked');
      expect(h[i]).toMatchObject({ from_status: 'OnTest', reason: 'LAB_FAIL' });
      expect(h.slice(0, i).some((x) => x.to_status === 'Processed')).toBe(false);
      expect(await q('SELECT 1 FROM batch_links WHERE parent_batch_id = $1', [b.id])).toHaveLength(0);
      const [t] = await q(
        `SELECT t.conclusion, t.recall_id, rb.status_before FROM lab_tests t
           JOIN recall_batches rb ON rb.recall_id = t.recall_id AND rb.batch_id = t.batch_id
          WHERE t.batch_id = $1 AND t.conclusion = 'FAIL'`,
        [b.id],
      );
      expect(t).toMatchObject({ conclusion: 'FAIL', status_before: 'Blocked' });
    }
  });
});

describe('VSD import (R81)', () => {
  it('every DAIRY/MEAT raw batch has one VSD row replayed against mercury-mock; others have none', async () => {
    const vsd = JSON.parse(
      readFileSync(new URL('../../../../mercury-mock/data/vsd.json', import.meta.url), 'utf8'),
    );
    const rows = await q(
      `SELECT b.id, b.kind, b.harvested_at, p.category, p.mercury_code, o.inn, d.id AS doc_id, d.import_status,
              d.number, d.issue_date::text AS issue_date, d.vsd_status, d.external_uuid, d.attempts, d.payload,
              d.created_at, b.created_at AS batch_created_at
         FROM batches b JOIN products p ON p.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id
         LEFT JOIN batch_documents d ON d.batch_id = b.id`,
    );
    expect(rows.filter((r) => r.doc_id).length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const animal = r.kind === 'RAW' && ['DAIRY', 'MEAT'].includes(r.category);
      expect(Boolean(r.doc_id), r.id).toBe(animal);
      if (!animal) continue;
      expect(iso(r.created_at)).toBe(iso(r.batch_created_at));
      const h = Date.parse(r.harvested_at);
      const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
      const [from, to] = [day(h - 3 * 86_400_000), day(h + 3 * 86_400_000)];
      const match = vsd
        .filter(
          (v: R) =>
            v.product.code === r.mercury_code &&
            v.consignor.inn === r.inn &&
            v.issueDate >= from &&
            v.issueDate <= to &&
            v.status === 'CONFIRMED',
        )
        .sort((a: R, b: R) =>
          a.issueDate === b.issueDate ? (a.number < b.number ? 1 : -1) : a.issueDate < b.issueDate ? 1 : -1,
        )[0];
      if (match) {
        expect(r).toMatchObject({
          import_status: 'IMPORTED',
          number: match.number,
          issue_date: match.issueDate,
          vsd_status: 'CONFIRMED',
          external_uuid: match.uuid,
          payload: match,
        });
      } else {
        expect(r).toMatchObject({ import_status: 'NOT_FOUND', number: null, payload: null });
      }
      expect(r.attempts).toBe(r.mercury_code ? 1 : 0);
    }
    expect(
      (await q(`SELECT name FROM products WHERE mercury_code IS NOT NULL ORDER BY name`)).map((p) => p.name),
    ).toEqual(['Говядина охлаждённая', 'Молоко сырое коровье']);
  });
});

describe('waybills', () => {
  it('statuses match their items: SENT → InTransit, ACCEPTED → actual masses and acts (BR-07)', async () => {
    const items = await q(
      `SELECT w.status AS ws, w.sender_org_id, w.receiver_org_id, w.sent_at, w.accepted_at, i.*, b.status AS bs
         FROM waybill_items i JOIN waybills w ON w.id = i.waybill_id JOIN batches b ON b.id = i.batch_id`,
    );
    for (const i of items) {
      if (i.ws === 'SENT') expect(['InTransit', 'Recalled']).toContain(i.bs);
      if (i.ws === 'ACCEPTED') {
        expect(i.mass_actual_kg).not.toBeNull();
        const d = checkDiscrepancy({ declaredKg: i.mass_declared_kg, actualKg: i.mass_actual_kg });
        if ('actRequired' in d && d.actRequired) expect(i.discrepancy_act).toBeTruthy();
        expect(i.accepted_at).not.toBeNull();
      } else {
        expect(i.mass_actual_kg).toBeNull();
      }
      if (i.ws === 'DRAFT') expect(i.sent_at).toBeNull();
    }
    expect(items.some((i) => i.discrepancy_act)).toBe(true);
  });
});

describe('lab tests', () => {
  it('results equal the product norms, conclusions follow BR-02, due dates are 5 working days', async () => {
    const tests = await q('SELECT t.*, b.product_id FROM lab_tests t JOIN batches b ON b.id = t.batch_id');
    expect(tests.length).toBeGreaterThanOrEqual(20);
    for (const t of tests) {
      expect(iso(t.due_at)).toBe(iso(addWorkingDays({ from: iso(t.created_at), days: 5 }).result));
      const results = await q('SELECT * FROM lab_results WHERE lab_test_id = $1', [t.id]);
      if (t.status !== 'DONE') {
        expect(results).toHaveLength(0);
        continue;
      }
      const norms = await q('SELECT indicator_id, max_value FROM norms WHERE product_id = $1', [
        t.product_id,
      ]);
      expect(results.map((r) => r.indicator_id).sort()).toEqual(norms.map((n) => n.indicator_id).sort());
      for (const r of results) {
        expect(r.norm_value_snapshot).toBe(norms.find((n) => n.indicator_id === r.indicator_id)!.max_value);
        expect(r.is_exceeded).toBe(compareDecimalStrings(r.value, r.norm_value_snapshot) > 0);
      }
      const c = concludeLabTest({
        results: results.map((r) => ({
          indicatorId: r.indicator_id,
          value: r.value,
          maxValue: r.norm_value_snapshot,
        })),
      });
      expect(c).toMatchObject({ conclusion: t.conclusion });
      expect(t.recall_id !== null).toBe(t.conclusion === 'FAIL');
      expect(t.protocol_file_id).not.toBeNull();
    }
    for (const t of tests.filter((x) => x.status === 'ESCALATED'))
      expect(Date.parse(t.escalated_at)).toBeGreaterThan(Date.parse(t.due_at));
    for (const t of tests.filter((x) => ['QUEUED', 'SAMPLED'].includes(x.status)))
      expect(Date.parse(t.due_at)).toBeGreaterThan(Date.parse(NOW));
  });
});

describe('recalls', () => {
  const MOVABLE = ['Created', 'OnTest', 'Approved', 'InTransit', 'Accepted', 'OnSale', 'Blocked'];

  it('recall_batches are exactly the engine traversal with minimal depth and the status before the recall', async () => {
    const recalls = await q('SELECT * FROM recalls');
    expect(recalls).toHaveLength(4);
    for (const r of recalls) {
      const expected = await q(
        `WITH RECURSIVE down AS (
           SELECT child_batch_id AS id, 1 AS depth FROM batch_links WHERE parent_batch_id = $1
           UNION SELECT l.child_batch_id, d.depth + 1 FROM batch_links l JOIN down d ON l.parent_batch_id = d.id WHERE d.depth < 20),
         up AS (
           SELECT parent_batch_id AS id, 1 AS depth FROM batch_links WHERE child_batch_id = $1 AND $2
           UNION SELECT l.parent_batch_id, u.depth + 1 FROM batch_links l JOIN up u ON l.child_batch_id = u.id WHERE u.depth < 20)
         SELECT $1::uuid AS id, 'SOURCE' AS direction, 0 AS depth
         UNION ALL SELECT id, 'DOWN', min(depth) FROM down WHERE id <> $1 GROUP BY id
         UNION ALL SELECT id, 'UP', min(depth) FROM up WHERE id <> $1 AND id NOT IN (SELECT id FROM down) GROUP BY id`,
        [r.source_batch_id, r.block_upstream],
      );
      const actual = await q(
        'SELECT batch_id AS id, direction, depth, status_before FROM recall_batches WHERE recall_id = $1',
        [r.id],
      );
      const key = (x: R): string => `${x.id}|${x.direction}|${x.depth}`;
      expect(actual.map(key).sort()).toEqual(expected.map(key).sort());
      for (const rb of actual) {
        const h = await q('SELECT * FROM batch_status_history WHERE batch_id = $1 ORDER BY id', [rb.id]);
        const recalledRow = h.find((x) => x.reason === 'RECALLED' && iso(x.changed_at) === iso(r.opened_at));
        const before = recalledRow
          ? recalledRow.from_status
          : h.filter((x) => Date.parse(x.changed_at) <= Date.parse(r.opened_at)).pop()!.to_status;
        expect(rb.status_before).toBe(before);
        expect(Boolean(recalledRow)).toBe(MOVABLE.includes(before));
        if (recalledRow) expect(recalledRow.changed_by).toBe(r.created_by);
      }
    }
  });

  it('a task exists exactly for every batch moved to Recalled, on its holder (receiver when in transit)', async () => {
    const recalls = await q('SELECT * FROM recalls');
    for (const r of recalls) {
      const members = await q(
        `SELECT rb.*, b.holder_org_id, b.status FROM recall_batches rb JOIN batches b ON b.id = rb.batch_id WHERE rb.recall_id = $1`,
        [r.id],
      );
      const tasks = await q('SELECT * FROM recall_tasks WHERE recall_id = $1', [r.id]);
      const moved = members.filter((m) => MOVABLE.includes(m.status_before));
      expect(tasks.map((t) => t.batch_id).sort()).toEqual(moved.map((m) => m.batch_id).sort());
      for (const t of tasks) {
        const m = members.find((x) => x.batch_id === t.batch_id)!;
        let holder = m.holder_org_id;
        if (m.status_before === 'InTransit') {
          const [w] = await q(
            `SELECT w.receiver_org_id FROM waybills w JOIN waybill_items i ON i.waybill_id = w.id WHERE i.batch_id = $1 AND w.status = 'SENT'`,
            [t.batch_id],
          );
          holder = w!.receiver_org_id;
        }
        expect(t.holder_org_id).toBe(holder);
        expect(iso(t.due_at)).toBe(iso(recallTaskDueAt({ openedAt: iso(r.opened_at) }).dueAt));
        expect(m.status).toBe(t.status === 'CONFIRMED' ? 'WrittenOff' : 'Recalled');
        if (t.status === 'OVERDUE') expect(Date.parse(t.escalated_at)).toBeGreaterThan(Date.parse(t.due_at));
        if (t.status === 'OPEN') expect(t.escalated_at).toBeNull();
      }
      for (const m of members.filter((x) => !MOVABLE.includes(x.status_before)))
        expect(m.status).toBe(m.status_before);
      const close = shouldCloseRecall({ taskStatuses: tasks.map((t) => t.status) }).close;
      expect(r.status).toBe(close ? 'CLOSED' : 'OPEN');
      if (close) {
        const last = tasks.length
          ? Math.max(...tasks.map((t) => Date.parse(t.confirmed_at)))
          : Date.parse(r.opened_at);
        expect(Date.parse(r.closed_at)).toBe(last);
      }
    }
  });

  it('the open recall recalled every downstream batch that could move, and the FAIL test links it (R57)', async () => {
    const [open] = await q(`SELECT * FROM recalls WHERE status = 'OPEN' AND trigger = 'LAB'`);
    const down = await q(
      `WITH RECURSIVE down AS (SELECT child_batch_id AS id FROM batch_links WHERE parent_batch_id = $1
         UNION SELECT l.child_batch_id FROM batch_links l JOIN down d ON l.parent_batch_id = d.id)
       SELECT b.status, rb.status_before FROM down JOIN batches b ON b.id = down.id
         JOIN recall_batches rb ON rb.batch_id = b.id AND rb.recall_id = $2`,
      [open!.source_batch_id, open!.id],
    );
    expect(down.length).toBeGreaterThanOrEqual(5);
    for (const d of down) {
      if (MOVABLE.includes(d.status_before)) expect(['Recalled', 'WrittenOff']).toContain(d.status);
      else expect(d.status).toBe(d.status_before);
    }
    const [fail] = await q(`SELECT * FROM lab_tests WHERE conclusion = 'FAIL'`);
    expect(fail!.recall_id).toBe(open!.id);
    expect(open!.lab_test_id).toBe(fail!.id);
  });

  it('complaint decisions link their lab test or recall', async () => {
    const decided = await q(`SELECT * FROM complaints WHERE status = 'DECIDED'`);
    expect(decided.map((c) => c.decision).sort()).toEqual(['LAB_TEST', 'RECALL']);
    for (const c of decided) {
      if (c.decision === 'RECALL') {
        const [r] = await q('SELECT * FROM recalls WHERE id = $1', [c.recall_id]);
        expect(r).toMatchObject({ trigger: 'COMPLAINT', complaint_id: c.id, source_batch_id: c.batch_id });
      }
      if (c.decision === 'LAB_TEST') {
        const [t] = await q('SELECT * FROM lab_tests WHERE id = $1', [c.lab_test_id]);
        expect(t).toMatchObject({ reason: 'COMPLAINT', batch_id: c.batch_id });
      }
    }
  });
});

describe('trust rating (BR-09)', () => {
  it('each FARM rating equals the contract fold over its tests and recalls; others have none (R84)', async () => {
    const orgs = await q('SELECT id, type, trust_rating FROM organizations');
    for (const o of orgs) {
      const events = await q(
        `SELECT t.completed_at AS at, 0 AS ord, t.id::text AS id,
                CASE t.conclusion WHEN 'PASS' THEN 'LAB_PASS' ELSE 'LAB_FAIL' END AS event
           FROM lab_tests t JOIN batches b ON b.id = t.batch_id
          WHERE t.status = 'DONE' AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.origin_org_id = $1
         UNION ALL
         SELECT r.opened_at, 1, r.id::text, 'RECALL_SOURCE'
           FROM recalls r JOIN batches b ON b.id = r.source_batch_id
          WHERE r.deleted_at IS NULL AND b.origin_org_id = $1
         ORDER BY 1, 2, 3`,
        [o.id],
      );
      const fold = events.reduce((current, e) => nextTrustRating({ current, event: e.event }).rating, 80);
      expect(o.trust_rating).toBe(o.type === 'FARM' ? fold : null); // R84
    }
    expect(
      (await q(`SELECT trust_rating FROM organizations WHERE type = 'FARM' AND trust_rating < 70`)).length,
    ).toBe(2); // Луговая and, after the barley FAIL + recall (R88 M8), Заря
  });
});

describe('notifications', () => {
  it('payloads carry exactly the keys of notifications.json; recipients are active users', async () => {
    const rows = await q(
      `SELECT n.type, n.payload, n.channel, u.status FROM notifications n JOIN users u ON u.id = n.user_id`,
    );
    for (const n of rows) {
      const keys = notificationRules.types[n.type as keyof typeof notificationRules.types].payload;
      expect(Object.keys(n.payload).sort(), n.type).toEqual([...keys].sort());
      expect(n.status).toBe('ACTIVE');
    }
    const types = new Set(rows.map((n) => n.type));
    for (const t of Object.keys(notificationRules.types)) expect(types, t).toContain(t);
    // forced types always go to EMAIL too (FR-NOTIF-03)
    const forced = await q(
      `SELECT 1 FROM notifications a WHERE a.channel = 'IN_APP' AND a.type = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM notifications e WHERE e.channel = 'EMAIL' AND e.user_id = a.user_id AND e.payload = a.payload AND e.type = a.type)`,
      [notificationRules.forcedChannels],
    );
    expect(forced).toHaveLength(0);
  });

  it('every dispatch reached exactly the recipient groups of notifications.json', async () => {
    const users = await q(
      `SELECT u.id, u.organization_id, u.is_org_admin, array_agg(r.code) AS roles FROM users u
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL GROUP BY u.id`,
    );
    const ofOrg = (org: unknown): string[] => users.filter((u) => u.organization_id === org).map((u) => u.id);
    const inspectors = users.filter((u) => u.roles.includes('INSPECTOR')).map((u) => u.id);
    const one = async (sql: string, id: unknown): Promise<R> => (await q(sql, [id]))[0]!;
    const groups: Record<string, (p: R, at: unknown) => Promise<string[]>> = {
      labOrg: async (p) =>
        ofOrg((await one('SELECT lab_org_id FROM lab_tests WHERE id = $1', p.labTestId)).lab_org_id),
      labOrgHeads: async (p) => {
        const lab = (await one('SELECT lab_org_id FROM lab_tests WHERE id = $1', p.labTestId)).lab_org_id;
        return users.filter((u) => u.organization_id === lab && u.is_org_admin).map((u) => u.id);
      },
      batchOrigin: async (p) =>
        ofOrg((await one('SELECT origin_org_id FROM batches WHERE id = $1', p.batchId)).origin_org_id),
      batchHolder: async (p, at) => {
        const origin = (await one('SELECT origin_org_id FROM batches WHERE id = $1', p.batchId))
          .origin_org_id;
        const holder = await holderAt(p.batchId, at);
        return holder === origin ? [] : ofOrg(holder);
      },
      waybillReceiver: async (p) =>
        ofOrg((await one('SELECT receiver_org_id FROM waybills WHERE id = $1', p.waybillId)).receiver_org_id),
      taskHolder: async (p) =>
        ofOrg((await one('SELECT holder_org_id FROM recall_tasks WHERE id = $1', p.taskId)).holder_org_id),
      taskHolders: async (p) =>
        (
          await q('SELECT DISTINCT holder_org_id FROM recall_tasks WHERE recall_id = $1', [p.recallId])
        ).flatMap((t) => ofOrg(t.holder_org_id)),
      sourceOrigin: async (p) =>
        ofOrg((await one('SELECT origin_org_id FROM batches WHERE id = $1', p.sourceBatchId)).origin_org_id),
      inspectors: async () => inspectors,
      inspectorsIfUnplanned: async (p) =>
        ['INSPECTOR', 'COMPLAINT'].includes(
          (await one('SELECT reason FROM lab_tests WHERE id = $1', p.labTestId)).reason,
        )
          ? inspectors
          : [],
    };
    const dispatches = await q(
      `SELECT type, payload, min(created_at) AS at, array_agg(user_id ORDER BY user_id) AS users
         FROM notifications WHERE channel = 'IN_APP' GROUP BY type, payload`,
    );
    expect(dispatches.length).toBeGreaterThan(50);
    for (const d of dispatches) {
      const rule = notificationRules.types[d.type as keyof typeof notificationRules.types] as {
        recipients: string[];
        recipientsOnClose?: string[];
      };
      const names =
        d.type === 'RECALL' && d.payload.event === 'CLOSED' ? rule.recipientsOnClose! : rule.recipients;
      const expected = new Set<string>();
      for (const g of names) {
        expect(groups[g], `unknown recipient group ${g}`).toBeDefined();
        for (const id of await groups[g]!(d.payload, d.at)) expected.add(id);
      }
      expect(d.users, `${d.type} ${JSON.stringify(d.payload)}`).toEqual([...expected].sort());
    }
  });
});

describe('entity lifecycles (contracts/rules/*state-machine*.json)', () => {
  const machines: Record<string, { transitions: { from: string; to: string }[]; statuses: string[] }> = {
    labTest: entityMachines.labTest,
    recall: entityMachines.recall,
    recallTask: entityMachines.recallTask,
    complaint: entityMachines.complaint,
    waybill: waybillMachine,
  };
  const tables: Record<string, string> = {
    labTest: 'lab_tests',
    recall: 'recalls',
    recallTask: 'recall_tasks',
    complaint: 'complaints',
    waybill: 'waybills',
  };

  for (const [type, machine] of Object.entries(machines)) {
    it(`${type}: the audited status changes follow the machine and end in the stored status`, async () => {
      const rows = await q(`SELECT id, status FROM ${tables[type]}`);
      expect(rows.length).toBeGreaterThan(0);
      const audit = await q(
        `SELECT entity_id, diff FROM audit_log WHERE entity_type = $1 AND diff ? 'status' ORDER BY id`,
        [type],
      );
      for (const r of rows) {
        const changes = audit
          .filter((a) => a.entity_id === r.id)
          .map((a) => a.diff.status as [string | null, string]);
        expect(changes[0]![0], `${type} ${r.id} created`).toBeNull();
        // creation shows the status at the end of the creating operation (a recall may close in it, BR-10)
        const initial = machine.statuses[0]!;
        let current = initial;
        if (changes[0]![1] !== initial) {
          expect(machine.transitions.some((t) => t.from === initial && t.to === changes[0]![1])).toBe(true);
        }
        current = changes[0]![1];
        for (const [from, to] of changes.slice(1)) {
          expect(from).toBe(current);
          expect(
            machine.transitions.some((t) => t.from === from && t.to === to),
            `${type}: ${from} → ${to}`,
          ).toBe(true);
          current = to;
        }
        expect(current).toBe(r.status);
      }
    });
  }
});

describe('start-up (R73)', () => {
  it('nothing is due for a scheduler: open tasks and queued/sampled tests are not past due, overdue ones are escalated', async () => {
    expect(await q(`SELECT 1 FROM recall_tasks WHERE status = 'OPEN' AND due_at < $1`, [NOW])).toHaveLength(
      0,
    );
    expect(
      await q(
        `SELECT 1 FROM lab_tests WHERE status IN ('QUEUED','SAMPLED') AND due_at < $1 AND deleted_at IS NULL`,
        [NOW],
      ),
    ).toHaveLength(0);
    expect(
      await q(
        `SELECT 1 FROM recall_tasks WHERE status = 'OVERDUE' AND (escalated_at IS NULL OR escalated_at <= due_at)`,
      ),
    ).toHaveLength(0);
    expect(
      await q(
        `SELECT 1 FROM lab_tests WHERE status = 'ESCALATED' AND (escalated_at IS NULL OR escalated_at <= due_at)`,
      ),
    ).toHaveLength(0);
    expect((await q(`SELECT 1 FROM recall_tasks WHERE status = 'OPEN'`)).length).toBeGreaterThan(0);
    expect((await q(`SELECT 1 FROM recall_tasks WHERE status = 'OVERDUE'`)).length).toBeGreaterThan(0);
  });
});

describe('users and files', () => {
  it('every demo user logs in with agrotrace-demo (Argon2id m=65536,t=3,p=1)', async () => {
    const users = await q('SELECT email, password_hash FROM users');
    expect(users).toHaveLength(data.users.length);
    for (const u of users) {
      expect(u.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      expect(await argon2.verify(u.password_hash, DEMO_PASSWORD), u.email).toBe(true);
    }
  });

  it('every stored file and variant exists in MinIO with the recorded size and sha256; images have WebP 96/480', async () => {
    const s3 = s3Client(env);
    const files = await q('SELECT * FROM files');
    expect(files.length).toBeGreaterThan(60);
    for (const f of files) {
      expect(f.object_key).toBe(
        `${f.object_key.split('/')[0]}/${iso(f.created_at).slice(0, 4)}/${iso(f.created_at).slice(5, 7)}/${f.id}/original`,
      );
      const objects: [string, number, string, string | null][] = [
        [f.object_key, Number(f.size_bytes), f.sha256, null],
      ];
      for (const [variant, v] of Object.entries(
        f.variants as Record<string, { key: string; size: number; sha256: string }>,
      )) {
        expect(v.key).toBe(f.object_key.replace(/original$/, variant));
        objects.push([v.key, v.size, v.sha256, variant]);
      }
      if (['AVATAR', 'PRODUCT_IMAGE'].includes(f.kind))
        expect(Object.keys(f.variants).sort()).toEqual(['480', '96']);
      else expect(f.variants).toEqual({});
      for (const [key, size, sha, variant] of objects) {
        const head = await s3.send(new HeadObjectCommand({ Bucket: f.bucket, Key: key }));
        expect(head.ContentLength, key).toBe(size);
        const body = Buffer.from(
          await (
            await s3.send(new GetObjectCommand({ Bucket: f.bucket, Key: key }))
          ).Body!.transformToByteArray(),
        );
        expect(createHash('sha256').update(body).digest('hex'), key).toBe(sha);
        if (variant) {
          const meta = await sharp(body).metadata();
          expect(meta.format).toBe('webp');
          expect(Math.max(meta.width!, meta.height!)).toBe(Number(variant));
        }
      }
      if (f.kind === 'QR' && f.mime === 'image/png') {
        const meta = await sharp(
          Buffer.from(
            await (
              await s3.send(new GetObjectCommand({ Bucket: f.bucket, Key: f.object_key }))
            ).Body!.transformToByteArray(),
          ),
        ).metadata();
        expect([meta.width, meta.height]).toEqual([1024, 1024]);
      }
    }
  });
});

/** docs/demo-accounts.md with table cells trimmed (`| a | b |`), whatever the column padding. */
/**
 * The committed document (rendered for REFERENCE_NOW, R86) with its codes moved to the year of this run's
 * SEED_NOW — "коды для года запуска: AT-<год>-…" — then normalized table cells.
 */
const demoAccounts = (): string =>
  readFileSync(new URL('../../docs/demo-accounts.md', SEED_ROOT), 'utf8')
    .replace(new RegExp(`\\b(AT|WB)-${REFERENCE_NOW.slice(0, 4)}-(\\d{6})\\b`, 'g'), `$1-${YEAR}-$2`)
    .split('\n')
    .map((l) => (l.startsWith('|') ? l.replace(/ *\| */g, ' | ').trim() : l))
    .join('\n');

describe('docs/demo-accounts.md', () => {
  it('lists every user of users.json and of the database with the demo password', async () => {
    const doc = demoAccounts();
    expect(doc).toContain(DEMO_PASSWORD);
    for (const u of data.users) expect(doc, u.email).toContain(`\`${u.email}\``);
    for (const u of await q('SELECT email FROM users')) expect(doc).toContain(u.email);
    for (const b of await q(
      `SELECT public_code FROM batches b JOIN recall_batches rb ON rb.batch_id = b.id AND rb.direction = 'SOURCE'`,
    )) {
      expect(doc).toContain(b.public_code);
    }
  });

  it('the account table matches the database (role, organization, head flag)', async () => {
    const doc = demoAccounts();
    const users = await q(
      `SELECT u.email, u.is_org_admin, o.name, r.code FROM users u JOIN organizations o ON o.id = u.organization_id
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id`,
    );
    for (const u of users) {
      expect(doc).toContain(`| \`${u.email}\` | ${u.code} | ${u.name} | ${u.is_org_admin ? 'да' : 'нет'} |`);
    }
  });

  it('the batch and waybill tables match the database', async () => {
    const doc = demoAccounts();
    const RU: Record<string, string> = {
      Создана: 'Created',
      'На анализе': 'OnTest',
      Допущена: 'Approved',
      'В пути': 'InTransit',
      Принята: 'Accepted',
      Переработана: 'Processed',
      'В продаже': 'OnSale',
      Реализована: 'Sold',
      Заблокирована: 'Blocked',
      Отозвана: 'Recalled',
      Списана: 'WrittenOff',
    };
    const batches = await q(
      'SELECT b.public_code, b.status, p.name, b.qr_png_file_id FROM batches b JOIN products p ON p.id = b.product_id',
    );
    const fullList = doc.slice(doc.indexOf('## Полный список партий'));
    for (const b of batches) {
      const line = fullList.split('\n').find((l) => l.startsWith(`| ${b.public_code} |`));
      expect(line, b.public_code).toBeDefined();
      const [, , product, , status] = line!.split('|').map((s) => s.trim());
      expect(product).toBe(b.name);
      const label = Object.keys(RU).find((k) => status!.startsWith(k));
      expect(label && RU[label], b.public_code).toBe(b.status);
      expect(status!.includes('QR'), b.public_code).toBe(b.qr_png_file_id !== null);
    }
    const waybillList = doc.slice(doc.indexOf('## Накладные'), doc.indexOf('## Полный список партий'));
    const waybills = await q('SELECT number, status FROM waybills');
    expect(waybills).toHaveLength(29);
    for (const w of waybills) {
      const line = waybillList.split('\n').find((l) => l.startsWith(`| ${w.number} |`));
      expect(line, w.number).toBeDefined();
      expect(line!.split('|')[2]!.trim(), w.number).toBe(w.status);
    }
  });
});
