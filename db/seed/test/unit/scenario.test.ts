import { readdirSync, readFileSync, statSync } from 'node:fs';
import { canTransition, type BatchStatus } from '@agrotrace/domain';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadData, SEED_ROOT } from '../../src/data';
import { logoSvg, AVATARS } from '../../src/images';
import { buildWorld } from '../../src/seed';
import { addDaysToDate } from '@agrotrace/domain';
import { generateDemoAccounts, renderDemoAccounts } from '../../src/docs';
import { at, iso, REFERENCE_NOW, seedNowFrom } from '../../src/time';
import { World, type Row } from '../../src/world';

const regions = ['33', '50', '37', '52', '76', '62'].map((code, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  code,
}));
const roles = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'].map((code, i) => ({
  id: i + 1,
  code,
}));
const world = (now = REFERENCE_NOW): World =>
  buildWorld(regions, roles, 'agrotrace', 'http://react-express.localhost', now);
const data = loadData();

describe('scenario', () => {
  const w = world();

  it('replays into 41 batches whose histories follow the state machine', () => {
    expect(w.t.batches).toHaveLength(41);
    for (const b of w.t.batches) {
      const h = w.t.batch_status_history.filter((x) => x.batch_id === b.id);
      for (const x of h.slice(1))
        expect(
          canTransition({ from: x.from_status as BatchStatus, to: x.to_status as BatchStatus }).allowed,
        ).toBe(true);
    }
  });

  it('is deterministic for a pinned SEED_NOW: two replays give identical rows', () => {
    const again = world();
    expect(JSON.stringify(again.t)).toBe(JSON.stringify(w.t));
    expect(JSON.stringify(again.notifications)).toBe(JSON.stringify(w.notifications));
    expect(JSON.stringify(again.audit.map((a) => [a.action, a.entityId, a.at]))).toBe(
      JSON.stringify(w.audit.map((a) => [a.action, a.entityId, a.at])),
    );
  });

  it('keeps the codes and states that docs/demo-accounts.md describes', () => {
    const code = (k: string): unknown => w.batch(k).public_code;
    expect([code('M1'), code('milk1'), code('M3'), code('carrot1'), code('M7')]).toEqual([
      'AT-2026-000001',
      'AT-2026-000002',
      'AT-2026-000010',
      'AT-2026-000027',
      'AT-2026-000040',
    ]);
    const tasks = (recall: string, keys: string[]): Record<string, unknown> =>
      Object.fromEntries(keys.map((k) => [k, w.task(recall, k).status]));
    expect(tasks('recall-milk', ['milk3', 'tvorog2', 'butter3', 'butter4'])).toEqual({
      milk3: 'CONFIRMED',
      tvorog2: 'OVERDUE',
      butter3: 'OVERDUE',
      butter4: 'OVERDUE',
    });
    expect(tasks('recall-cream', ['butter2', 'ghee1'])).toEqual({ butter2: 'OPEN', ghee1: 'OPEN' });
    expect(w.recall('recall-milk').status).toBe('OPEN');
    expect(w.recall('recall-cream').status).toBe('OPEN');
    expect(w.recall('recall-carrot').status).toBe('CLOSED');
    expect(w.waybill('wb-barley1-draft').number).toBe('WB-2026-000026');
    const tilt = w.t.treatments.find((t) => t.substance_id === w.keys.substance.get('tilt')!.id)!;
    expect(w.br01(w.seedNow, 'wb-barley1-draft')).toEqual([
      {
        ok: false,
        until: addDaysToDate(String(tilt.applied_at).slice(0, 10), 30),
        substance: 'Тилт, КЭ (пропиконазол)',
      },
    ]);
    expect(Date.parse(tilt.applied_at as string)).toBe(Date.parse(w.seedNow) - (15 * 24 + 3) * 3_600_000);
  });

  it('risk-model lab tests have no author (R74)', () => {
    for (const t of w.t.lab_tests) {
      if (t.reason === 'RISK' || t.reason === 'PLANNED') expect(t.created_by, t._key as string).toBeNull();
      else expect(t.created_by).not.toBeNull();
    }
  });

  it('shifts with SEED_NOW: any moment gives a valid world a scheduler tick would not change (R73)', () => {
    for (const now of [
      '2027-01-04T00:00:00Z',
      '2026-12-31T23:57:00Z',
      '2028-02-29T13:41:00Z',
      '2026-09-24T18:05:00Z',
    ]) {
      const v = world(now);
      expect(v.t.batches.map((b) => b.status)).toEqual(w.t.batches.map((b) => b.status));
      expect(v.batch('M1').public_code).toBe(`AT-${now.slice(0, 4)}-000001`);
      expect(v.waybill('wb-M1').number).toBe(`WB-${now.slice(0, 4)}-000001`);
      for (const t of v.t.recall_tasks) {
        if (t.status === 'OPEN') expect(Date.parse(t.due_at as string)).toBeGreaterThan(Date.parse(now));
      }
      for (const t of v.t.lab_tests) {
        if (['QUEUED', 'SAMPLED'].includes(t.status as string)) {
          expect(Date.parse(t.due_at as string)).toBeGreaterThan(Date.parse(now));
        }
      }
      const shift = Date.parse(now) - Date.parse(REFERENCE_NOW);
      expect(v.recall('recall-cream').opened_at).toBe(
        iso(Date.parse(w.recall('recall-cream').opened_at as string) + shift),
      );
    }
  });

  it('a lab FAIL on a not-yet-processed batch blocks it, and the FAIL recall moves it on (R88 M8)', () => {
    const b = w.batch('barley2');
    expect(b.public_code).toBe('AT-2026-000041');
    const h = w.t.batch_status_history
      .filter((x) => x.batch_id === b.id)
      .map((x) => `${x.from_status ?? '∅'}→${x.to_status} ${x.reason as string}`);
    expect(h).toEqual([
      '∅→Created CREATED',
      'Created→OnTest TEST_REQUIRED',
      'OnTest→Blocked LAB_FAIL',
      'Blocked→Recalled RECALLED',
    ]);
    expect(w.test('barley2:risk')).toMatchObject({ status: 'DONE', conclusion: 'FAIL' });
    const r = w.recall('recall-barley');
    expect(r).toMatchObject({ trigger: 'LAB', status: 'OPEN', source_batch_id: b.id });
    expect(w.t.recall_batches.find((x) => x.recall_id === r.id && x.batch_id === b.id)).toMatchObject({
      direction: 'SOURCE',
      status_before: 'Blocked',
    });
    expect(w.task('recall-barley', 'barley2').status).toBe('OPEN');
    expect(w.t.batch_links.some((l) => l.parent_batch_id === b.id)).toBe(false);
  });

  it('VSD import (R81): one VSD row per DAIRY/MEAT raw batch, replayed against the mercury-mock data', () => {
    const animal = (v: World): Row[] =>
      v.t.batches.filter(
        (b) => b.kind === 'RAW' && ['DAIRY', 'MEAT'].includes(v.productById(b.product_id).category as string),
      );
    expect(animal(w).map((b) => b._key)).toEqual(['M1', 'M2', 'M3', 'beef1', 'M4', 'M5', 'M6', 'M7']);
    expect(w.t.batch_documents.map((d) => d.batch_id).sort()).toEqual(
      animal(w)
        .map((b) => b.id)
        .sort(),
    );
    const byKey = (v: World) =>
      Object.fromEntries(
        animal(v).map((b) => {
          const d = v.t.batch_documents.find((x) => x.batch_id === b.id)!;
          return [
            b._key,
            { status: d.import_status, attempts: d.attempts, number: d.number, date: d.issue_date },
          ];
        }),
      );
    const imported = {
      M3: { status: 'IMPORTED', attempts: 1, number: 'VSD-2026-000011', date: '2026-07-08' },
      beef1: { status: 'IMPORTED', attempts: 1, number: 'VSD-2026-000012', date: '2026-08-02' },
    };
    const notFound = { status: 'NOT_FOUND', attempts: 1, number: null, date: null };
    const expected = (dates: Record<string, string>) =>
      Object.fromEntries(
        ['M1', 'M2', 'M3', 'beef1', 'M4', 'M5', 'M6', 'M7'].map((k) => [
          k,
          k in imported ? { ...imported[k as keyof typeof imported], date: dates[k] } : notFound,
        ]),
      );
    expect(byKey(w)).toEqual(expected({ M3: '2026-07-08', beef1: '2026-08-02' }));
    const later = world('2026-09-30T09:00:00Z');
    expect(byKey(later)).toEqual(expected({ M3: '2026-07-18', beef1: '2026-08-12' }));
    const m3 = later.t.batch_documents.find((d) => d.batch_id === later.batch('M3').id)!;
    expect(m3).toMatchObject({
      vsd_status: 'CONFIRMED',
      external_uuid: '3304dbab-b7aa-485d-a945-ec4036f08727',
    });
    expect(m3.payload).toMatchObject({ issueDate: '2026-07-18', vetInspection: { date: '2026-07-17' } });
    expect(later.audit.filter((a) => a.action === 'system.vsdImport')).toHaveLength(8);
  });

  it('SEED_NOW parsing: explicit ISO minute, or the real clock truncated to the minute', () => {
    expect(seedNowFrom('2026-10-01T12:34:00Z')).toBe('2026-10-01T12:34:00Z');
    expect(seedNowFrom('2026-10-01T15:34:00+03:00')).toBe('2026-10-01T12:34:00Z');
    expect(seedNowFrom(undefined, Date.parse('2026-10-01T12:34:56.789Z'))).toBe('2026-10-01T12:34:00Z');
    expect(() => seedNowFrom('2026-10-01T12:34:30Z')).toThrow(/whole minute/);
    expect(() => seedNowFrom('yesterday')).toThrow(/ISO/);
  });

  it('docs/demo-accounts.md is the generator output for REFERENCE_NOW (R86)', () => {
    const doc = readFileSync(new URL('../../docs/demo-accounts.md', SEED_ROOT), 'utf8');
    expect(doc).toBe(generateDemoAccounts());
    expect(doc).toBe(renderDemoAccounts(world(REFERENCE_NOW)));
    expect(doc).toContain(`момента сценария ${REFERENCE_NOW} (REFERENCE_NOW)`);
    expect(doc).toMatch(/коды для года запуска: AT-<год>-…/);
  });

  it('rejects an invalid step instead of writing it', () => {
    const fresh = (): World => {
      const v = new World(data, regions, roles, 'agrotrace', 'http://x', REFERENCE_NOW);
      v.seedOrganizations(at('2026-05-11 10:00'));
      v.seedDictionaries(at('2026-05-12 10:00'), 'admin');
      v.createField(at('2026-05-18 09:10'), 'zarya.agronom', 'zarya-north');
      v.createTreatment(
        at('2026-05-18 09:20'),
        'zarya.agronom',
        'zarya-north',
        'banvel',
        '0.300',
        'л/га',
        at('2026-05-18 06:00'),
      );
      const b = v.createBatch(at('2026-05-19 09:00'), 'zarya.agronom', 'x', {
        field: 'zarya-north',
        product: 'wheat',
        massKg: '100',
        harvestedAt: at('2026-05-19 06:00'),
      });
      expect(b.status).toBe('OnTest');
      v.createWaybill(at('2026-05-19 11:00'), 'zarya.head', 'wb', 'melkombinat', [{ batch: 'x' }]);
      return v;
    };
    expect(() => fresh().putOnSale(at('2026-05-19 12:00'), 'provizia.head', 'x')).toThrow(/NOT_HOLDER/);
    expect(() => fresh().sendWaybill(at('2026-05-19 12:00'), 'zarya.head', 'wb')).toThrow(
      /INVALID_TRANSITION/,
    );
    expect(() => fresh().markSold(at('2026-05-19 12:00'), 'zarya.head', 'x')).toThrow(/lacks role/);
    expect(() =>
      fresh().createBatch(at('2026-05-19 08:00'), 'zarya.agronom', 'y', {
        field: 'zarya-north',
        product: 'wheat',
        massKg: '1',
        harvestedAt: at('2026-05-19 06:00'),
      }),
    ).toThrow(/time goes backwards/);
    const v = fresh();
    v.registerLabSample(at('2026-05-19 13:00'), 'agrotest.head', 'x:risk');
    v.submitLabResults(at('2026-05-20 13:00'), 'agrotest.head', 'x:risk');
    expect(() => v.sendWaybill(at('2026-05-21 12:00'), 'zarya.head', 'wb')).toThrow(/BR-01.*2026-07-02/);
  });
});

describe('data files', () => {
  const innOk = (s: string): boolean => {
    const d = [...s].map(Number);
    const c = (w: number[]): number => (w.reduce((sum, x, i) => sum + x * d[i]!, 0) % 11) % 10;
    if (d.length === 10) return c([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    return c([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && c([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  };

  it('INNs have valid checksums and reuse the Mercury emulator organizations (R66)', () => {
    for (const o of data.organizations) expect(innOk(o.inn), o.name).toBe(true);
    const vsd = JSON.parse(readFileSync(new URL('data/vsd.json', SEED_ROOT), 'utf8')) as {
      consignor: { inn: string; name: string };
      consignee: { inn: string; name: string };
    }[];
    const mercury = new Map(vsd.flatMap((v) => [v.consignor, v.consignee]).map((o) => [o.name, o.inn]));
    for (const o of data.organizations)
      if (mercury.has(o.name)) expect(o.inn, o.name).toBe(mercury.get(o.name));
    expect(data.organizations.filter((o) => mercury.has(o.name))).toHaveLength(5);
  });

  it('field areas match their contours (±3 %)', () => {
    for (const f of data.fields) {
      const ring = f.geometry.coordinates[0]!;
      const lat0 = (ring.reduce((s, p) => s + p[1]!, 0) / ring.length) * (Math.PI / 180);
      const R = 6371008.8;
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i]!.map((v) => (v * Math.PI) / 180) as [number, number];
        const [x2, y2] = ring[i + 1]!.map((v) => (v * Math.PI) / 180) as [number, number];
        a += x1 * Math.cos(lat0) * R * y2 * R - x2 * Math.cos(lat0) * R * y1 * R;
      }
      const ha = Math.abs(a) / 2 / 10_000;
      expect(Math.abs(ha - Number(f.areaHa)) / ha, f.key).toBeLessThan(0.03);
    }
  });

  it('users: lowercase unique emails, a head in every organization', () => {
    const emails = data.users.map((u) => u.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) expect(e).toBe(e.toLowerCase());
    for (const o of data.organizations)
      expect(
        data.users.some((u) => u.org === o.key && u.isOrgAdmin),
        o.key,
      ).toBe(true);
  });
});

describe('images', () => {
  it('logos are the generator output for every organization', () => {
    const files = readdirSync(new URL('images/logos/', SEED_ROOT)).sort();
    expect(files).toEqual(data.organizations.map((o) => `${o.key}.svg`).sort());
    for (const o of data.organizations) {
      expect(readFileSync(new URL(`images/logos/${o.key}.svg`, SEED_ROOT), 'utf8'), o.key).toBe(
        logoSvg(o.name),
      );
    }
  });

  it('6 avatars are 512 px JPEG illustrations', async () => {
    for (const name of Object.keys(AVATARS)) {
      const meta = await sharp(readFileSync(new URL(`images/avatars/${name}.jpg`, SEED_ROOT))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 512, 512]);
    }
    expect(Object.keys(AVATARS)).toHaveLength(6);
  });

  it('15 product photos: JPEG ≤ 300 KB, each attributed with a CC0 / CC BY / CC BY-SA license', async () => {
    const attribution = readFileSync(new URL('ATTRIBUTION.md', SEED_ROOT), 'utf8');
    expect(data.products).toHaveLength(15);
    for (const p of data.products) {
      const url = new URL(`images/products/${p.image}`, SEED_ROOT);
      expect(statSync(url).size, p.image).toBeLessThanOrEqual(300 * 1024);
      expect((await sharp(readFileSync(url)).metadata()).format).toBe('jpeg');
      const row = attribution.split('\n').find((l) => l.startsWith(`| \`${p.image}\` |`));
      expect(row, p.image).toMatch(/\[CC(0| BY(-SA)? [\d.]+)\]\(https?:\/\/creativecommons\.org\//);
      expect(row).toMatch(/<https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
    expect(readdirSync(new URL('images/products/', SEED_ROOT))).toHaveLength(15);
  });
});
