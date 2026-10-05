import { describe, expect, it } from 'vitest';
import { storageCounters } from '../src/config.js';
import { expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const s = () => mock.api.store;
const as = (who: string) => mock.login(`${who}@agrotrace.test`);
const code = (n: number) => `AT-2026-${String(n).padStart(6, '0')}`;
const batch = (n: number) => s().t.batches.find((b) => b.public_code === code(n))!;
type Item = Record<string, unknown>;

describe('list filters and card fields', () => {
  it('users: the status filter, and the text search matches the e-mail too', async () => {
    const admin = await as('admin');
    await expectStatus(201, 'POST', '/users', { token: admin, body: { email: 'invited.one@agrotrace.test', fullName: 'Приглашённый Один', roles: ['FARMER'], isOrgAdmin: false, organizationId: s().t.organizations.find((o) => o.name.includes('Заря'))!.id } });
    const invited = (await expectStatus(200, 'GET', '/users?size=100&status=INVITED', { token: admin })).body;
    expect(invited.items.map((u: Item) => u.email)).toEqual(['invited.one@agrotrace.test']);
    const all = (await expectStatus(200, 'GET', '/users?size=100', { token: admin })).body;
    expect(all.total).toBeGreaterThan(invited.total);
    const byMail = (await expectStatus(200, 'GET', '/users?size=100&q=zarya.agronom', { token: admin })).body;
    expect(byMail.items.map((u: Item) => u.email)).toEqual(['zarya.agronom@agrotrace.test']);
  });

  it('organization card: a trust rating only for farms', async () => {
    const insp = await as('inspector');
    const mol = s().t.organizations.find((o) => o.name.includes('Молкомбинат'))!;
    s().patch(mol, { trust_rating: 4 });
    expect((await expectStatus(200, 'GET', `/organizations/${mol.id}`, { token: insp })).body.trustRating).toBeNull();
    const zarya = s().t.organizations.find((o) => o.name.includes('Заря'))!;
    expect((await expectStatus(200, 'GET', `/organizations/${zarya.id}`, { token: insp })).body.trustRating).toBe(zarya.trust_rating);
    expect(zarya.trust_rating).not.toBeNull();
  });

  it('treatments: the substance filter', async () => {
    const counts = new Map<string, Set<string>>();
    for (const t of s().t.treatments) (counts.get(t.field_id) ?? counts.set(t.field_id, new Set()).get(t.field_id)!).add(t.substance_id);
    const [fieldId, subs] = [...counts].find(([, v]) => v.size >= 2)!;
    const field = s().get('fields', fieldId)!;
    const owner = s().t.users.find((u) => u.organization_id === field.organization_id && u.email.endsWith('@agrotrace.test') && u.status === 'ACTIVE')!;
    const token = await mock.login(owner.email);
    const sub = [...subs][0]!;
    const r = (await expectStatus(200, 'GET', `/fields/${fieldId}/treatments?size=100&substanceId=${sub}`, { token })).body;
    const expected = s().t.treatments.filter((t) => t.field_id === fieldId && t.substance_id === sub).length;
    expect([r.total, new Set(r.items.map((t: { substance: { id: string } }) => t.substance.id))]).toEqual([expected, new Set([sub])]);
  });

  it('batch history: oldest first', async () => {
    const h = (await expectStatus(200, 'GET', `/batches/${batch(27).id}/history`, { token: await as('inspector') })).body as { at: string; to: string }[];
    expect(h.length).toBeGreaterThan(2);
    expect(h.map((x) => x.at)).toEqual([...h.map((x) => x.at)].sort());
    expect(h.at(-1)!.to).toBe('WrittenOff');
  });

  it('waybills: the status filter; batches: the kind filter', async () => {
    const insp = await as('inspector');
    const sent = (await expectStatus(200, 'GET', '/waybills?size=100&status=SENT', { token: insp })).body;
    const all = (await expectStatus(200, 'GET', '/waybills?size=100', { token: insp })).body;
    expect(sent.total).toBeGreaterThan(0);
    expect(sent.total).toBeLessThan(all.total);
    expect(new Set(sent.items.map((w: Item) => w.status))).toEqual(new Set(['SENT']));
    const derived = (await expectStatus(200, 'GET', '/batches?size=100&kind=DERIVED', { token: insp })).body;
    expect(derived.total).toBe(s().t.batches.filter((b) => b.deleted_at === null && b.kind === 'DERIVED').length);
    expect(new Set(derived.items.map((b: Item) => b.kind))).toEqual(new Set(['DERIVED']));
  });

  it('QR: the holder of an OnSale batch may create it', async () => {
    const b = batch(28);
    expect(b.status).toBe('OnSale');
    const r = await expectStatus(201, 'POST', `/batches/${b.id}/qr`, { token: await as('provizia.head') });
    expect(r.body.publicUrl).toBe(`http://localhost/p/${b.public_code}`);
  });
});

describe('rate-limit counters: quota fallback', () => {
  it('a refused write keeps counting from the last known count, never from zero', () => {
    const data = new Map<string, string>();
    let full = false;
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('quota', 'QuotaExceededError');
        data.set(k, v);
      },
      removeItem: (k: string) => void data.delete(k),
    } as Storage;
    const c = storageCounters(storage);
    const T = 1_000_000;
    for (let i = 1; i <= 5; i++) expect(c.hit('rl:x', T + 60_000, T)).toBe(i);
    full = true;
    expect(c.hit('rl:x', T + 60_000, T)).toBe(6);
    expect(c.hit('rl:x', T + 60_000, T)).toBe(7);
    expect(c.peek('rl:x', T)).toBe(7);
    full = false;
    expect(c.hit('rl:x', T + 60_000, T)).toBe(8);
    expect(JSON.parse(data.get('agrotrace-mock-api:rate-limits')!)['rl:x'][0]).toBe(8);
  });
});
