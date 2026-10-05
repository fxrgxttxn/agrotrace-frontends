import { afterEach, describe, expect, it, vi } from 'vitest';
import { webLock, type CrossTabLock } from '../src/config.js';
import { createMockApi, DEMO_PASSWORD, memoryCounters, solveChallenge, type MockApi } from '../src/index.js';
import { expectStatus } from './helpers/client.js';
import { nodeAssetLoader } from './helpers/assets.js';
import { useMock } from './helpers/mock.js';

const T0 = Date.parse('2026-10-14T10:00:00Z');

describe('one backend', () => {
  const mock = useMock();
  const s = () => mock.api.store;
  const code = (n: number) => `AT-2026-${String(n).padStart(6, '0')}`;
  const waybill = (n: number) =>
    s().t.waybills.find((w) => w.number === `WB-2026-${String(n).padStart(6, '0')}`)!;
  const memberOf = (orgId: string) =>
    s()
      .t.users.filter(
        (u) => u.organization_id === orgId && u.status === 'ACTIVE' && u.email.endsWith('@agrotrace.test'),
      )
      .sort((a, b) => Number(b.is_org_admin) - Number(a.is_org_admin))[0]!.email;
  const conflict = (r: { body: { code: string } }) => expect(r.body.code).toBe('VERSION_CONFLICT');

  it('VERSION_CONFLICT: acceptWaybill and rejectWaybill with a stale If-Match', async () => {
    const w = waybill(27);
    const t = await mock.login(memberOf(w.receiver_org_id));
    const card = await expectStatus(200, 'GET', `/waybills/${w.id}`, { token: t });
    const items = card.body.items.map((i: { batch: { id: string }; massDeclaredKg: string }) => ({
      batchId: i.batch.id,
      massActualKg: i.massDeclaredKg,
    }));
    const stale = String(card.body.version + 1);
    conflict(
      await expectStatus(409, 'POST', `/waybills/${w.id}/accept`, {
        token: t,
        headers: { 'If-Match': stale, 'Idempotency-Key': 'r3-accept-00001' },
        body: { items },
      }),
    );
    conflict(
      await expectStatus(409, 'POST', `/waybills/${w.id}/reject`, {
        token: t,
        headers: { 'If-Match': stale },
        body: { reason: 'x' },
      }),
    );
  });

  it('VERSION_CONFLICT: registerLabSample, submitLabResults, confirmRecallTask with a stale If-Match', async () => {
    const queued = s().t.lab_tests.find((x) => x.status === 'QUEUED' && x.deleted_at === null)!;
    const lab = await mock.login(memberOf(queued.lab_org_id));
    conflict(
      await expectStatus(409, 'POST', `/lab-tests/${queued.id}/sample`, {
        token: lab,
        headers: { 'If-Match': String(queued.version + 1) },
      }),
    );
    const sampled = await expectStatus(200, 'POST', `/lab-tests/${queued.id}/sample`, {
      token: lab,
      headers: { 'If-Match': String(queued.version) },
    });
    const results = sampled.body.norms.map((n: { indicatorId: string }) => ({
      indicatorId: n.indicatorId,
      value: '0',
    }));
    conflict(
      await expectStatus(409, 'POST', `/lab-tests/${queued.id}/results`, {
        token: lab,
        headers: { 'If-Match': String(sampled.body.version - 1) },
        body: { results },
      }),
    );

    const task = s().t.recall_tasks.find((x) => x.status === 'OPEN')!;
    const holder = await mock.login(memberOf(task.holder_org_id));
    conflict(
      await expectStatus(409, 'POST', `/recall-tasks/${task.id}/confirm`, {
        token: holder,
        headers: { 'If-Match': String(task.version + 1), 'Idempotency-Key': 'r3-confirm-0001' },
      }),
    );
  });

  it('soft-deleted rows: lab tests leave labSummary, a deleted batch has no public page, a deleted complaint is 404', async () => {
    const done = s().t.lab_tests.filter(
      (x) => x.status === 'DONE' && x.deleted_at === null && x.completed_at,
    );
    const batch = s().t.batches.find((b) => b.deleted_at === null && done.some((x) => x.batch_id === b.id))!;
    const before = await expectStatus(200, 'GET', `/public/batches/${batch.public_code}`);
    expect(before.body.labSummary.total).toBeGreaterThan(0);
    s().patch(
      done.find((x) => x.batch_id === batch.id)!,
      { deleted_at: s().nowIso() },
    );
    const after = await expectStatus(200, 'GET', `/public/batches/${batch.public_code}`);
    expect(after.body.labSummary.total).toBe(before.body.labSummary.total - 1);
    s().patch(batch, { deleted_at: s().nowIso() });
    await expectStatus(404, 'GET', `/public/batches/${batch.public_code}`);

    const insp = await mock.login('inspector@agrotrace.test');
    const complaint = s().t.complaints.find((c) => c.deleted_at === null)!;
    await expectStatus(200, 'GET', `/complaints/${complaint.id}`, { token: insp });
    s().patch(complaint, { deleted_at: s().nowIso() });
    await expectStatus(404, 'GET', `/complaints/${complaint.id}`, { token: insp });
    expect(code(1)).toBe('AT-2026-000001');
  });

  it('R50: rejecting reassigns the open task to the sender with a new version; a CONFIRMED task stays', async () => {
    const w = waybill(27);
    const batchIds = s()
      .t.waybill_items.filter((i) => i.waybill_id === w.id)
      .map((i) => i.batch_id);
    const open = s().t.recall_tasks.find(
      (x) =>
        batchIds.includes(x.batch_id) && x.holder_org_id === w.receiver_org_id && x.status !== 'CONFIRMED',
    )!;
    expect(open).toBeDefined();
    const confirmed = s().insert('recall_tasks', {
      ...structuredClone(open),
      id: '00000000-0000-4000-8000-0000000e0001',
      status: 'CONFIRMED',
      confirmed_at: s().nowIso(),
      confirmed_by: s().t.users.find((u) => u.organization_id === w.receiver_org_id)!.id,
    });
    const [openVersion, confirmedVersion] = [open.version, confirmed.version];
    const t = await mock.login(memberOf(w.receiver_org_id));
    await expectStatus(200, 'POST', `/waybills/${w.id}/reject`, {
      token: t,
      headers: { 'If-Match': String(w.version) },
      body: { reason: 'Партия отозвана' },
    });
    expect([open.holder_org_id, open.version]).toEqual([w.sender_org_id, openVersion + 1]);
    expect([confirmed.holder_org_id, confirmed.version]).toEqual([w.receiver_org_id, confirmedVersion]);
  });
});

interface Tabs {
  tabs: MockApi[];
  lockUses: () => number;
  storageEvent(): void;
  restore(): void;
}

function tabs(n: number, opts: { rateLimits?: boolean } = {}): Tabs {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as Storage;
  const blobsMap = new Map<string, Uint8Array>();
  const blobStore = {
    get: async (k: string) => blobsMap.get(k),
    put: async (k: string, v: Uint8Array) => void blobsMap.set(k, v),
    clear: async () => blobsMap.clear(),
  };
  let q: Promise<unknown> = Promise.resolve();
  let uses = 0;
  const lock: CrossTabLock = <T>(fn: () => Promise<T>) => {
    uses += 1;
    const next = q.then(fn);
    q = next.catch(() => undefined);
    return next;
  };
  const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
  const saved = { add: g.addEventListener, remove: g.removeEventListener };
  const listeners = new Set<(e: { key: string | null }) => void>();
  g.addEventListener = (type: string, fn: (e: { key: string | null }) => void) =>
    type === 'storage' && listeners.add(fn);
  g.removeEventListener = (type: string, fn: (e: { key: string | null }) => void) =>
    type === 'storage' && listeners.delete(fn);
  const list = Array.from({ length: n }, () =>
    createMockApi({
      now: () => T0,
      loadAsset: nodeAssetLoader,
      persist: storage,
      blobStore,
      lock,
      rateLimits: opts.rateLimits ?? false,
      verifyPersistence: true,
    }),
  );
  return {
    tabs: list,
    lockUses: () => uses,
    storageEvent: () => {
      for (const fn of listeners) fn({ key: 'agrotrace-mock-api:version' });
    },
    restore: () => {
      for (const t of list) t.dispose();
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
    },
  };
}

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
const loginIn = async (api: MockApi, email: string) =>
  (
    await (
      await api.handle(req('/auth/login', { method: 'POST', json: { email, password: DEMO_PASSWORD } }))
    ).json()
  ).accessToken as string;

async function stream(api: MockApi, token: string, lastEventId?: string) {
  const res = await api.handle(
    req(
      `/events/stream?access_token=${token}`,
      lastEventId === undefined ? {} : { headers: { 'Last-Event-ID': lastEventId } },
    ),
  );
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const drain = async (ms = 150): Promise<string> => {
    for (;;) {
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), ms))]);
      if (r === null) return text;
      pending = null;
      if (r.done) {
        done = true;
        return text;
      }
      text += dec.decode(r.value);
    }
  };
  await drain();
  return {
    drain,
    get done() {
      return done;
    },
    ids: () => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
    cancel: () => reader.cancel(),
  };
}

const complain = async (api: MockApi, publicCode: string) => {
  const challenge = await (await api.handle(req('/public/captcha'))).json();
  const r = await api.handle(
    req(`/public/batches/${publicCode}/complaints`, {
      method: 'POST',
      json: { text: 'Жалоба на качество продукции.', altcha: solveChallenge(challenge) },
    }),
  );
  expect(r.status).toBe(201);
};

describe('SSE across tabs', () => {
  let env: Tabs | null = null;
  afterEach(() => {
    env?.restore();
    env = null;
  });

  it('a storage event delivers another tab notifications to their users only, each exactly once', async () => {
    env = tabs(2);
    const [a, c] = env.tabs as [MockApi, MockApi];
    await Promise.all([a.ready, c.ready]);
    const inspectors = c.store.t.users.filter(
      (u) => u.roles.includes('INSPECTOR') && u.status === 'ACTIVE' && u.email.endsWith('@agrotrace.test'),
    );
    const streams = await Promise.all(
      inspectors.map(async (u) => ({ user: u, s: await stream(c, await loginIn(c, u.email)) })),
    );

    const zarya = await loginIn(a, 'zarya.head@agrotrace.test');
    const org = (part: string) => a.store.t.organizations.find((o) => o.name.includes(part))!;
    const apples = a.store.t.batches.find((b) => b.public_code === 'AT-2026-000031')!;
    const wb = await (
      await a.handle(
        req('/waybills', {
          method: 'POST',
          token: zarya,
          headers: { 'Idempotency-Key': 'r3-sse-wb-0001' },
          json: {
            receiverOrgId: org('Мелькомбинат').id,
            items: [{ batchId: apples.id, massDeclaredKg: apples.mass_kg }],
          },
        }),
      )
    ).json();
    expect(
      (
        await a.handle(
          req(`/waybills/${wb.id}/send`, {
            method: 'POST',
            token: zarya,
            headers: { 'If-Match': '1', 'Idempotency-Key': 'r3-sse-send-01' },
          }),
        )
      ).status,
    ).toBe(200);
    const seqBefore = a.store.seq.notification;
    await complain(a, 'AT-2026-000028');
    const complaintRows = a.store.t.notifications.filter((n) => n.type === 'COMPLAINT');
    expect(complaintRows.length).toBeGreaterThan(0);

    env.storageEvent();
    for (const { user, s } of streams) {
      const text = await s.drain(300);
      expect(text, user.email).not.toContain('"type":"WAYBILL_INCOMING"');
      const mine = complaintRows.filter((n) => n.user_id === user.id && n.seq > seqBefore).map((n) => n.seq);
      expect(s.ids(), user.email).toEqual(mine);
    }

    const petrov = await loginIn(a, 'petrov@agrotrace.test');
    await a.handle(
      req('/fields', {
        method: 'POST',
        token: petrov,
        json: { name: 'R3', areaHa: '1.00', regionCode: '33' },
      }),
    );
    env.storageEvent();
    for (const { user, s } of streams) {
      await s.drain(300);
      const ids = s.ids();
      expect(new Set(ids).size, `${user.email}: ${ids.join(',')}`).toBe(ids.length);
    }
    for (const { s } of streams) await s.cancel();
  });

  it('a request in the tab delivers what another tab created (without a storage event)', async () => {
    env = tabs(2);
    const [a, c] = env.tabs as [MockApi, MockApi];
    await Promise.all([a.ready, c.ready]);
    const s = await stream(c, await loginIn(c, 'inspector@agrotrace.test'));
    await complain(a, 'AT-2026-000028');
    expect(await s.drain(200)).not.toContain('"type":"COMPLAINT"');
    await c.handle(req('/health/live'));
    expect(await s.drain(200)).toContain('"type":"COMPLAINT"');
    await s.cancel();
  });

  it('the read-through of a storage event takes the cross-tab lock (round 4)', async () => {
    env = tabs(2);
    const [a, c] = env.tabs as [MockApi, MockApi];
    await Promise.all([a.ready, c.ready]);
    await a.handle(req('/health/live'));
    const uses = env.lockUses();
    env.storageEvent();
    await c.ready;
    expect(env.lockUses()).toBe(uses + 2);
  });

  it('expired world keys are swept as a change of the world (dirty, persisted)', async () => {
    env = tabs(2);
    const [a, c] = env.tabs as [MockApi, MockApi];
    await Promise.all([a.ready, c.ready]);
    await a.handle(req('/health/live'));
    a.store.kvSet('probe', 1, 60);
    await a.handle(req('/health/live'));
    a.store.kv.get('probe')!.expiresAt = T0 - 1;
    await a.handle(req('/health/live'));
    await c.handle(req('/health/live'));
    expect(c.store.kv.has('probe')).toBe(false);
  });

  it('a reset runs under the cross-tab lock; the other tab closes its old-world streams and ignores their ids', async () => {
    env = tabs(2);
    const [a, c] = env.tabs as [MockApi, MockApi];
    await Promise.all([a.ready, c.ready]);
    const token = await loginIn(c, 'inspector@agrotrace.test');
    const s = await stream(c, token);
    await complain(a, 'AT-2026-000028');
    await c.handle(req('/health/live'));
    await s.drain();
    const lastId = Math.max(...s.ids());

    const uses = env.lockUses();
    await a.reset();
    expect(env.lockUses()).toBeGreaterThan(uses);
    await c.handle(req('/health/live'));
    await s.drain();
    expect(s.done).toBe(true);
    expect(c.openStreams).toBe(0);
    const inspectorId = c.store.t.users.find((u) => u.email === 'inspector@agrotrace.test')!.id;
    const newIds = c.store.t.notifications
      .filter((n) => n.user_id === inspectorId)
      .map((n) => n.seq)
      .sort((x, y) => x - y);
    expect(newIds.length).toBeGreaterThan(0);
    expect(Math.min(...c.store.t.notifications.map((n) => n.seq))).toBeGreaterThan(lastId);
    const fresh = await loginIn(c, 'inspector@agrotrace.test');
    const again = await stream(c, fresh, String(lastId));
    expect(again.ids()).toEqual(newIds);
    await again.cancel();
  });
});

describe('runtime details', () => {
  it('webLock(): the origin lock, exclusive, the result passed through; null without navigator.locks', async () => {
    const g = globalThis as { navigator?: unknown };
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const calls: [string, unknown][] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: (name: string, opts: unknown, fn: () => Promise<unknown>) => (
            calls.push([name, opts]),
            fn()
          ),
        },
      },
    });
    try {
      const lock = webLock()!;
      expect(await lock(async () => 42)).toBe(42);
      expect(calls).toEqual([['agrotrace-mock-api', { mode: 'exclusive' }]]);
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
      expect(webLock()).toBeNull();
    } finally {
      if (had) Object.defineProperty(globalThis, 'navigator', had);
      else delete g.navigator;
    }
  });

  it('persistence without navigator.locks warns once per page', async () => {
    vi.resetModules();
    const fresh = (await import('../src/index.js')) as typeof import('../src/index.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as Storage;
    const x = fresh.createMockApi({
      now: () => T0,
      loadAsset: nodeAssetLoader,
      persist: storage,
      blobStore: null,
    });
    const y = fresh.createMockApi({
      now: () => T0,
      loadAsset: nodeAssetLoader,
      persist: storage,
      blobStore: null,
    });
    const z = fresh.createMockApi({
      now: () => T0,
      loadAsset: nodeAssetLoader,
      persist: storage,
      blobStore: null,
      lock: null,
    });
    await Promise.all([x.ready, y.ready, z.ready]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('navigator.locks'))).toHaveLength(1);
    warn.mockRestore();
    for (const t of [x, y, z]) t.dispose();
  });

  it('expired keys are deleted, not kept forever (world keys and rate-limit windows)', async () => {
    let t = T0;
    const counters = memoryCounters();
    const api = createMockApi({
      now: () => t,
      loadAsset: nodeAssetLoader,
      persist: false,
      rateLimits: true,
      counters,
    });
    await api.ready;
    const login = () =>
      api.handle(
        req('/auth/login', {
          method: 'POST',
          json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD },
        }),
      );
    await login();
    const first = counters.keys().filter((k) => k.startsWith('rl:login-ip:'));
    expect(first).toHaveLength(1);
    api.store.kvSet('probe', 1, 60);
    t += 5 * 60_000;
    await login();
    expect(counters.keys().filter((k) => k.startsWith('rl:login-ip:'))).toEqual([
      expect.not.stringMatching(first[0]!),
    ]);
    expect(api.store.kv.has('probe')).toBe(false);
    api.dispose();
  });
});
