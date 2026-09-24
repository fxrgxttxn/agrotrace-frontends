import { readdirSync, readFileSync, statSync } from 'node:fs';
import { canTransition, type BatchStatus } from '@agrotrace/domain';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadData, SEED_ROOT } from '../../src/data';
import { logoSvg, AVATARS } from '../../src/images';
import { buildWorld } from '../../src/seed';
import { at } from '../../src/time';
import { World } from '../../src/world';

const regions = ['33', '50', '37', '52', '76', '62'].map((code, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  code,
}));
const roles = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'].map((code, i) => ({
  id: i + 1,
  code,
}));
const world = (): World => buildWorld(regions, roles, 'agrotrace', 'http://react-express.localhost');
const data = loadData();

describe('scenario', () => {
  const w = world();

  it('replays into 40 batches whose histories follow the state machine', () => {
    expect(w.t.batches).toHaveLength(40);
    for (const b of w.t.batches) {
      const h = w.t.batch_status_history.filter((x) => x.batch_id === b.id);
      for (const x of h.slice(1))
        expect(
          canTransition({ from: x.from_status as BatchStatus, to: x.to_status as BatchStatus }).allowed,
        ).toBe(true);
    }
  });

  it('is deterministic: two replays give identical rows', () => {
    const again = world();
    expect(JSON.stringify(again.t)).toBe(JSON.stringify(w.t));
    expect(JSON.stringify(again.notifications)).toBe(JSON.stringify(w.notifications));
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
    const tasks = Object.fromEntries(
      ['milk3', 'tvorog2', 'butter3', 'butter4'].map((k) => [k, w.task('recall-milk', k).status]),
    );
    expect(tasks).toEqual({ milk3: 'CONFIRMED', tvorog2: 'OVERDUE', butter3: 'OPEN', butter4: 'OVERDUE' });
    expect(w.recall('recall-carrot').status).toBe('CLOSED');
    expect(w.waybill('wb-barley1-draft').number).toBe('WB-2026-000026');
    expect(w.br01(at('2026-09-20 09:00'), 'wb-barley1-draft')).toEqual([
      { ok: false, until: '2026-10-05', substance: 'Тилт, КЭ (пропиконазол)' },
    ]);
  });

  it('rejects an invalid step instead of writing it', () => {
    /** A farm with one freshly registered wheat batch `x` (NEW_FARM → OnTest) and a draft waybill of it. */
    const fresh = (): World => {
      const v = new World(data, regions, roles, 'agrotrace', 'http://x');
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
    // Банвел (45 days) applied 18.05 blocks shipping until 02.07 (BR-01).
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
    const vsd = JSON.parse(readFileSync(new URL('../../mercury-mock/data/vsd.json', SEED_ROOT), 'utf8')) as {
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
