/** Contract table freshness, the validator itself, rate limits, schedulers, persistence, generated files. */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';
import { operationTable } from '../scripts/contract-table.js';
import { OPERATIONS } from '../src/contract/operations.generated.js';
import { createMockApi, DEMO_PASSWORD, type CrossTabLock, type MockApi } from '../src/index.js';
import { readXlsx, writeXlsx } from '../src/lib/xlsx.js';
import { Store } from '../src/store/store.js';
import { contractErrors } from './helpers/client.js';
import { nodeAssetLoader } from './helpers/assets.js';

const webp = new Uint8Array(readFileSync(new URL('../assets/seed/avatars/avatar-1-96.webp', import.meta.url)));
const T0 = Date.parse('2026-10-14T10:00:00Z');
const req = (path: string, init: RequestInit & { json?: unknown; token?: string } = {}) =>
  new Request(`http://localhost/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

describe('contract table', () => {
  it('src/contract/operations.generated.ts matches the contract (run `pnpm gen` when it does not)', async () => {
    expect(OPERATIONS).toEqual(await operationTable(inject('contract')));
    expect(OPERATIONS).toHaveLength(92);
  });

  it('the response validator rejects what the contract forbids', () => {
    expect(contractErrors('getMe', 'GET', '/me', 200, 'application/json', { id: 'x' })).not.toEqual([]);
    expect(contractErrors('getMe', 'GET', '/me', 418, 'application/json', {})).not.toEqual([]);
    expect(contractErrors('getMe', 'GET', '/me', 401, 'text/plain', '')).not.toEqual([]);
  });
});

describe('rate limits', () => {
  it('login-ip: the 21st login in a minute is 429 with Retry-After and params', async () => {
    const api = createMockApi({ now: () => T0 + 5_000, loadAsset: nodeAssetLoader });
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) last = await api.handle(req('/auth/login', { method: 'POST', json: { email: 'x@agrotrace.test', password: 'x' } }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBe('55');
    expect((await last!.json()).params).toEqual({ scope: 'login-ip', limit: 20, windowSec: 60 });
    api.dispose();
  });
});

describe('schedulers', () => {
  it('overdue recall tasks and lab tests are escalated as the clock passes their due time', async () => {
    let t = T0;
    const api = createMockApi({ now: () => t, loadAsset: nodeAssetLoader });
    await api.ready;
    const open = api.store.t.recall_tasks.filter((x) => x.status === 'OPEN');
    expect(open.length).toBeGreaterThan(0);
    t += 8 * 86_400_000;
    await api.handle(req('/health/live'));
    expect(open.every((x) => x.status === 'OVERDUE' && x.escalated_at)).toBe(true);
    expect(api.store.t.lab_tests.some((x) => x.status === 'QUEUED' || x.status === 'SAMPLED')).toBe(false);
    expect(api.store.t.notifications.filter((n) => n.type === 'OVERDUE' && Date.parse(n.created_at) === t).length).toBeGreaterThan(0);
    expect(api.store.t.audit_log.some((a) => a.action === 'system.recallTaskOverdue')).toBe(true);
    api.dispose();
  });
});

describe('one backend per origin (FM3)', () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return {
      data,
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      } as Storage,
    };
  };
  const memoryBlobs = () => {
    const m = new Map<string, Uint8Array>();
    return { m, blobs: { get: async (k: string) => m.get(k), put: async (k: string, v: Uint8Array) => void m.set(k, v), clear: async () => m.clear() } };
  };

  it('tabs share the session (cookie jar), logout, data, uploads, GET side effects and reset', async () => {
    let t = T0;
    const { storage, data } = memoryStorage();
    const { blobs, m } = memoryBlobs();
    const opts = { now: () => t, loadAsset: nodeAssetLoader, persist: storage, blobStore: blobs };
    const a = createMockApi(opts);
    await a.ready;
    const b = createMockApi(opts);
    await b.ready;
    expect(b.store.t.batches.length).toBe(a.store.t.batches.length);

    const login = await (await a.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json();
    // A new tab restores the session through the shared refresh cookie.
    const inB = await b.handle(req('/auth/refresh', { method: 'POST' }));
    expect(inB.status).toBe(200);
    const bToken = (await inB.json()).accessToken as string;

    const f = await a.handle(req('/fields', { method: 'POST', token: login.accessToken, json: { name: 'Общее поле', areaHa: '1.00', regionCode: '33' } }));
    expect(f.status).toBe(201);
    const list = await (await b.handle(req('/fields?size=100', { token: bToken }))).json();
    expect(list.items.some((x: { name: string }) => x.name === 'Общее поле')).toBe(true);

    const form = new FormData();
    form.set('file', new File([webp], 'a.webp'));
    const up = await (await a.handle(req('/me/avatar', { method: 'PUT', token: login.accessToken, body: form }))).json();
    expect(m.has(up.id)).toBe(true);
    expect(data.get('agrotrace-mock-api')!).not.toContain(Buffer.from(webp).toString('base64').slice(0, 40));
    const img = await b.handle(req(up.url.replace('/api/v1', '')));
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(webp);

    // A GET in A runs the schedulers; B sees the escalations without writing anything itself.
    t += 8 * 86_400_000;
    await a.handle(req('/health/live'));
    const overdue = await (await b.handle(req('/recall-tasks?status=OVERDUE&size=100', { token: (await (await b.handle(req('/auth/login', { method: 'POST', json: { email: 'inspector@agrotrace.test', password: DEMO_PASSWORD } }))).json()).accessToken }))).json();
    expect(overdue.total).toBeGreaterThan(3);

    // Logout in A revokes the refresh cookie of B.
    await a.handle(req('/auth/logout', { method: 'POST' }));
    expect((await b.handle(req('/auth/refresh', { method: 'POST' }))).status).toBe(401);

    await a.reset();
    expect(m.size).toBe(0);
    const again = await (await b.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json();
    const after = await (await b.handle(req('/fields?size=100', { token: again.accessToken }))).json();
    expect(after.items.some((x: { name: string }) => x.name === 'Общее поле')).toBe(false);
    a.dispose();
    b.dispose();
  });

  /** A lock shared by the "tabs" of a test — what navigator.locks is to the tabs of an origin. */
  const sharedLock = (): CrossTabLock => {
    let q: Promise<unknown> = Promise.resolve();
    return <T,>(fn: () => Promise<T>) => {
      const next = q.then(fn);
      q = next.catch(() => undefined);
      return next;
    };
  };
  const fieldNames = async (api: MockApi, token: string, re: RegExp) =>
    ((await (await api.handle(req('/fields?size=100', { token }))).json()).items as { name: string }[]).map((x) => x.name).filter((n) => re.test(n)).sort();

  it('FM8: concurrent writes of two tabs are all kept (20/20), also while a tab only reads', async () => {
    const { storage } = memoryStorage();
    const { blobs } = memoryBlobs();
    const opts = { now: () => T0, loadAsset: nodeAssetLoader, persist: storage, blobStore: blobs, lock: sharedLock(), verifyPersistence: true };
    const a = createMockApi(opts);
    const b = createMockApi(opts);
    await Promise.all([a.ready, b.ready]);
    const token = (await (await a.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json()).accessToken;
    const create = (api: MockApi, name: string) => api.handle(req('/fields', { method: 'POST', token, json: { name, areaHa: '1.00', regionCode: '33' } }));
    const statuses = (await Promise.all(Array.from({ length: 10 }, (_, i) => [create(a, `A${i}`), create(b, `B${i}`)]).flat())).map((r) => r.status);
    expect(statuses.every((x) => x === 201)).toBe(true);
    await Promise.all([...Array.from({ length: 10 }, (_, i) => create(a, `C${i}`)), ...Array.from({ length: 30 }, () => b.handle(req('/fields?size=1', { token })))]);
    const c = createMockApi(opts);
    await c.ready;
    expect(await fieldNames(c, token, /^[ABC]\d$/)).toHaveLength(30);
    for (const x of [a, b, c]) x.dispose();
  });

  it('FM8: every write primitive of the store marks it dirty', () => {
    const s = new Store(() => T0);
    const region = { id: '00000000-0000-4000-8000-0000000000aa', code: '99', name: 'X' };
    const steps: [string, () => void][] = [
      ['insert', () => void s.insert('regions', region)],
      ['patch', () => void s.patch(region, { name: 'Y' })],
      ['remove', () => s.remove('regions', region)],
      ['kvSet', () => s.kvSet('k', 1, null)],
      ['kvDel', () => s.kvDel('k')],
      ['id', () => void s.id('x')],
      ['markDirty', () => s.markDirty()],
    ];
    for (const [name, step] of steps) {
      s.dirty = false;
      step();
      expect(s.dirty, name).toBe(true);
    }
    // A key that expires is deleted on read — also a change.
    s.kvSet('ttl', 1, 1);
    const later = new Store(() => T0 + 5_000);
    later.kv = s.kv;
    expect(later.kvGet('ttl')).toBeUndefined();
    expect(later.dirty, 'expiry on read').toBe(true);
  });

  it('FM8: a request that changes nothing writes nothing', async () => {
    const { storage } = memoryStorage();
    let writes = 0;
    const counting = { getItem: storage.getItem, removeItem: storage.removeItem, setItem: (k: string, v: string) => ((writes += 1), storage.setItem(k, v)) } as Storage;
    const api = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader, persist: counting, blobStore: null, rateLimits: false, lock: sharedLock(), verifyPersistence: true });
    await api.ready;
    const token = (await (await api.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json()).accessToken;
    const w = writes;
    for (let i = 0; i < 5; i++) expect((await api.handle(req('/fields?size=5', { token }))).status).toBe(200);
    expect(writes).toBe(w);
    await api.handle(req('/fields', { method: 'POST', token, json: { name: 'W', areaHa: '1.00', regionCode: '33' } }));
    expect(writes).toBeGreaterThan(w);
    api.dispose();
  });

  it('FM8: without a lock the pending idempotency mark is published before the operation runs', async () => {
    const { storage, data } = memoryStorage();
    const seen: string[] = [];
    const spying = { getItem: storage.getItem, removeItem: storage.removeItem, setItem: (k: string, v: string) => (k === 'agrotrace-mock-api' && seen.push(v), storage.setItem(k, v)) } as Storage;
    const api = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader, persist: spying, blobStore: null, lock: null });
    await api.ready;
    const token = (await (await api.handle(req('/auth/login', { method: 'POST', json: { email: 'zarya.head@agrotrace.test', password: DEMO_PASSWORD } }))).json()).accessToken;
    const org = (part: string) => api.store.t.organizations.find((o) => o.name.includes(part))!;
    const b = api.store.t.batches.find((x) => x.holder_org_id === org('Заря').id && x.status === 'Approved' && x.deleted_at === null)!;
    seen.length = 0;
    const body = { receiverOrgId: org('Мелькомбинат').id, items: [{ batchId: b.id, massDeclaredKg: b.mass_kg }] };
    const r = await api.handle(req('/waybills', { method: 'POST', token, headers: { 'Idempotency-Key': 'fm8-pending-01' }, json: body }));
    expect(r.status).toBe(201);
    const marks = seen.map((json) => (JSON.parse(json).kv as [string, { value: { state: string } }][]).find(([k]) => k.endsWith(':fm8-pending-01'))?.[1].value.state);
    expect(marks).toEqual(['pending', 'done']);
    expect(data.get('agrotrace-mock-api')).toContain('"state":"done"');
    api.dispose();
  });

  it('FM8: a reset in one tab empties what the other tab believes is in the blob store', async () => {
    const { storage } = memoryStorage();
    const { blobs, m } = memoryBlobs();
    const opts = { now: () => T0, loadAsset: nodeAssetLoader, persist: storage, blobStore: blobs, lock: sharedLock() };
    const a = createMockApi(opts);
    const b = createMockApi(opts);
    await Promise.all([a.ready, b.ready]);
    const upload = async (api: MockApi, bytes: Uint8Array) => {
      const token = (await (await api.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json()).accessToken;
      const form = new FormData();
      form.set('file', new File([bytes], 'a.webp'));
      return (await (await api.handle(req('/me/avatar', { method: 'PUT', token, body: form }))).json()) as { id: string; url: string };
    };
    const first = await upload(b, webp);
    await a.reset();
    const other = webp.slice();
    other[other.length - 1]! ^= 1;
    const second = await upload(b, other);
    // The world is replayed with the same ids: the new upload gets the id of the old one — its bytes must be stored.
    expect(second.id).toBe(first.id);
    expect(m.get(second.id)).toEqual(other);
    const c = createMockApi(opts);
    await c.ready;
    expect(new Uint8Array(await (await c.handle(req(second.url.replace('/api/v1', '')))).arrayBuffer())).toEqual(other);
    for (const x of [a, b, c]) x.dispose();
  });

  it('a storage failure (quota) is reported, never silent, and the request still answers', async () => {
    const quota = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); }, removeItem: () => undefined } as unknown as Storage;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    const api = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader, persist: quota, blobStore: null });
    await api.ready;
    const r = await api.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }));
    expect(r.status).toBe(200);
    expect(api.persistError).toBeInstanceOf(DOMException);
    expect(errors.length).toBeGreaterThan(0);
    spy.mockRestore();
    api.dispose();
  });
});
describe('generated files', () => {
  it('XLSX written by the mock reads back; a seeded protocol and a report PDF are written for a visual check', async () => {
    const x = writeXlsx([{ name: 'Лист', header: ['name', 'type', 'waitingPeriodDays'], rows: [[{ t: 'text', v: 'Пр & <тест>' }, { t: 'text', v: 'PESTICIDE' }, { t: 'int', v: 12 }]] }]);
    const back = readXlsx(x);
    expect(back.header).toEqual(['name', 'type', 'waitingPeriodDays']);
    expect(back.rows).toEqual([{ number: 2, cells: ['Пр & <тест>', 'PESTICIDE', '12'] }]);

    const api = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader });
    await api.ready;
    const login = await (await api.handle(req('/auth/login', { method: 'POST', json: { email: 'admin@agrotrace.test', password: DEMO_PASSWORD } }))).json();
    const form = new FormData();
    form.set('file', new File([x], 'substances.xlsx'));
    const imported = await api.handle(req('/dictionaries/substances/import', { method: 'POST', token: login.accessToken, body: form }));
    expect(await imported.json()).toEqual({ created: 1, updated: 0, unchanged: 0, errors: [] });

    const out = process.env.MOCK_API_ARTIFACTS;
    if (out) {
      const p = api.store.t.files.find((f) => f.kind === 'LAB_PROTOCOL')!;
      if (p.content.type === 'bytes') writeFileSync(`${out}/protocol.pdf`, p.content.data);
      const qr = api.store.t.files.find((f) => f.kind === 'QR' && f.mime === 'application/pdf')!;
      if (qr.content.type === 'bytes') writeFileSync(`${out}/qr-label.pdf`, qr.content.data);
      const png = api.store.t.files.find((f) => f.kind === 'QR' && f.mime === 'image/png')!;
      if (png.content.type === 'bytes') writeFileSync(`${out}/qr.png`, png.content.data);
      const insp = await (await api.handle(req('/auth/login', { method: 'POST', json: { email: 'inspector@agrotrace.test', password: DEMO_PASSWORD } }))).json();
      const rep = await api.handle(req(`/reports/recall?format=pdf&id=${api.store.t.recalls[1]!.id}`, { token: insp.accessToken }));
      writeFileSync(`${out}/recall.pdf`, new Uint8Array(await rep.arrayBuffer()));
    }
    api.dispose();
  });
});
