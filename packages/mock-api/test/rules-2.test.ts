import { describe, expect, it } from 'vitest';
import {
  createMockApi,
  DEMO_PASSWORD,
  memoryCounters,
  type MockApi,
  type RateCounters,
} from '../src/index.js';
import { sha256hex } from '../src/lib/crypto.js';
import { AVATAR_MAX_BYTES } from '../src/modules/profile.js';
import { nodeAssetLoader } from './helpers/assets.js';
import { contractErrors, operationOf } from './helpers/client.js';

const T0 = Date.parse('2026-10-14T10:00:00Z');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Env {
  api: MockApi;
  counters: RateCounters;
  advance(ms: number): void;
  call(
    method: string,
    path: string,
    o?: { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> },
  ): Promise<{ status: number; headers: Headers; body: Json }>;
  login(email: string): Promise<string>;
}

async function env(opts: { rateLimits?: boolean } = {}): Promise<Env> {
  let t = T0;
  const counters = memoryCounters();
  const api = createMockApi({
    now: () => t,
    loadAsset: nodeAssetLoader,
    rateLimits: opts.rateLimits ?? false,
    persist: false,
    counters,
  });
  await api.ready;
  const call: Env['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await api.handle(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers,
        body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined),
      }),
    );
    const text = await res.text();
    const type = res.headers.get('Content-Type')?.split(';')[0] ?? null;
    const body = type?.includes('json') ? JSON.parse(text) : text;
    const op = operationOf(method, path.split('?')[0]!)!;
    const errors = contractErrors(
      op.operationId,
      method,
      op.path,
      res.status,
      text.length ? type : null,
      body,
    );
    if (errors.length) throw new Error(errors.join('\n'));
    return { status: res.status, headers: res.headers, body };
  };
  return {
    api,
    counters,
    advance: (ms) => (t += ms),
    call,
    login: async (email) =>
      (await call('POST', '/auth/login', { json: { email, password: DEMO_PASSWORD } })).body.accessToken,
  };
}

const orgOf = (api: MockApi, part: string) => api.store.t.organizations.find((o) => o.name.includes(part))!;
const userOf = (api: MockApi, email: string) => api.store.t.users.find((u) => u.email === email)!;
const recipients = (api: MockApi, type: string, pred: (p: Record<string, unknown>) => boolean, from = 0) =>
  [
    ...new Set(
      api.store.t.notifications
        .slice(from)
        .filter((n) => n.type === type && pred(n.payload))
        .map((n) => n.user_id),
    ),
  ].sort();

describe('recall engine', () => {
  it('DOWN reaches depth 20 and not 21; soft-deleted members are left out; tasks notify ACTIVE users only', async () => {
    const { api, call, login } = await env();
    const s = api.store;
    const zarya = orgOf(api, 'Заря');
    const proto = s.t.batches.find((b) => b.holder_org_id === zarya.id && b.deleted_at === null)!;
    const chain = Array.from({ length: 22 }, (_, i) =>
      s.insert('batches', {
        ...structuredClone(proto),
        id: `00000000-0000-4000-8000-0000000c${String(i).padStart(4, '0')}`,
        public_code: `AT-2026-99${String(i).padStart(4, '0')}`,
        status: 'Approved',
        origin_org_id: zarya.id,
        holder_org_id: zarya.id,
        deleted_at: null,
      }),
    );
    for (let i = 1; i < chain.length; i++)
      s.insert('batch_links', {
        id: `00000000-0000-4000-8000-0000000d${String(i).padStart(4, '0')}`,
        parent_batch_id: chain[i - 1]!.id,
        child_batch_id: chain[i]!.id,
        mass_used_kg: '1.000',
        created_at: s.nowIso(),
      });
    s.patch(chain[5]!, { deleted_at: s.nowIso() });
    const agronom = userOf(api, 'zarya.agronom@agrotrace.test');
    s.patch(agronom, { status: 'BLOCKED' });

    const insp = await login('inspector@agrotrace.test');
    const seen = s.t.notifications.length;
    const r = await call('POST', '/recalls', {
      token: insp,
      json: { sourceBatchId: chain[0]!.id, reason: 'Глубина', blockUpstream: false },
    });
    expect(r.status).toBe(201);
    const depth = new Map<string, number>(
      r.body.batches.map((x: { batch: { id: string }; depth: number }) => [x.batch.id, x.depth]),
    );
    expect(depth.get(chain[20]!.id)).toBe(20);
    expect(depth.has(chain[21]!.id)).toBe(false);
    expect(depth.has(chain[5]!.id)).toBe(false);
    expect(chain[5]!.status).toBe('Approved');
    expect(depth.get(chain[6]!.id)).toBe(6);

    const zaryaActive = s.t.users
      .filter((u) => u.organization_id === zarya.id && u.status === 'ACTIVE' && u.deleted_at === null)
      .map((u) => u.id)
      .sort();
    expect(zaryaActive.length).toBeGreaterThan(0);
    expect(recipients(api, 'RECALL_TASK', (p) => p.recallId === r.body.id)).toEqual(zaryaActive);
    expect(s.t.notifications.slice(seen).some((n) => n.user_id === agronom.id)).toBe(false);
  });
});

describe('notification recipients', () => {
  it('LAB_OVERDUE goes to the heads of the lab (not every member) and ACTIVE inspectors', async () => {
    const { api, advance, call } = await env();
    const s = api.store;
    const blocked = userOf(api, 'inspector.head@agrotrace.test');
    s.patch(blocked, { status: 'BLOCKED' });
    const before = s.t.notifications.length;
    advance(8 * 86_400_000);
    await call('GET', '/health/live');
    const overdue = s.t.notifications.slice(before).filter((n) => n.type === 'LAB_OVERDUE');
    expect(overdue.length).toBeGreaterThan(0);
    const labs = new Set(overdue.map((n) => n.payload.labOrgId as string));
    const active = s.t.users.filter((u) => u.status === 'ACTIVE' && u.deleted_at === null);
    for (const lab of labs) {
      const expected = active
        .filter((u) => (u.organization_id === lab && u.is_org_admin) || u.roles.includes('INSPECTOR'))
        .map((u) => u.id)
        .sort();
      expect(recipients(api, 'LAB_OVERDUE', (p) => p.labOrgId === lab, before)).toEqual(expected);
    }
    const analyst = userOf(api, 'vetlab.analyst@agrotrace.test');
    expect(analyst.is_org_admin).toBe(false);
    expect(labs.has(analyst.organization_id)).toBe(true);
    expect(overdue.some((n) => n.user_id === analyst.id || n.user_id === blocked.id)).toBe(false);
  });
});

describe('rate limits', () => {
  it('login-ip: the 20th login in a window passes, the 21st is 429', async () => {
    const { call } = await env({ rateLimits: true });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push(
        (await call('POST', '/auth/login', { json: { email: 'x@agrotrace.test', password: 'x' } })).status,
      );
    expect(statuses.slice(0, 20).every((x) => x === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('a valid Bearer on a signed file URL counts in `user`; the URL alone does not', async () => {
    const { api, counters, call, login } = await env({ rateLimits: true });
    const token = await login('petrov@agrotrace.test');
    const me = await call('GET', '/me', { token });
    const url = (me.body.avatarUrl as string).replace('/api/v1', '');
    const counter = () => {
      const start = Math.floor(api.store.now() / 60_000) * 60;
      return counters.peek(`rl:user:${me.body.id}:${start}`, api.store.now());
    };
    const c0 = counter();
    expect((await call('GET', url)).status).toBe(200);
    expect(counter()).toBe(c0);
    expect((await call('GET', url, { token })).status).toBe(200);
    expect(counter()).toBe(c0 + 1);
  });
});

describe('idempotency (R48)', () => {
  const waybillBody = (api: MockApi) => {
    const zarya = orgOf(api, 'Заря');
    const b = api.store.t.batches.find(
      (x) => x.holder_org_id === zarya.id && x.status === 'Approved' && x.deleted_at === null,
    )!;
    return {
      receiverOrgId: orgOf(api, 'Мелькомбинат').id,
      items: [{ batchId: b.id, massDeclaredKg: b.mass_kg }],
    };
  };

  it('a 4xx is not kept: the same request runs again (no Idempotent-Replayed)', async () => {
    const { api, call, login } = await env();
    const token = await login('zarya.head@agrotrace.test');
    const bad = { receiverOrgId: orgOf(api, 'Мелькомбинат').id, items: [] };
    const h = { 'Idempotency-Key': 'r2-4xx-000001' };
    const first = await call('POST', '/waybills', { token, json: bad, headers: h });
    expect(first.status).toBe(400);
    const again = await call('POST', '/waybills', { token, json: bad, headers: h });
    expect(again.status).toBe(400);
    expect(again.headers.get('Idempotent-Replayed')).toBeNull();
    expect([...api.store.kv.keys()].some((k) => k.endsWith(':r2-4xx-000001'))).toBe(false);
  });

  it('keys are per user: the same key, path and body of another user is not a replay', async () => {
    const { api, call, login } = await env();
    const body = waybillBody(api);
    const h = { 'Idempotency-Key': 'r2-user-00001' };
    const first = await call('POST', '/waybills', {
      token: await login('zarya.head@agrotrace.test'),
      json: body,
      headers: h,
    });
    expect(first.status).toBe(201);
    const same = await call('POST', '/waybills', {
      token: await login('zarya.head@agrotrace.test'),
      json: body,
      headers: h,
    });
    expect(same.headers.get('Idempotent-Replayed')).toBe('true');
    const other = await call('POST', '/waybills', {
      token: await login('petrov@agrotrace.test'),
      json: body,
      headers: h,
    });
    expect(other.headers.get('Idempotent-Replayed')).toBeNull();
    expect(other.status).not.toBe(201);
  });

  it('a key still pending is 409 IDEMPOTENCY_KEY_IN_PROGRESS with Retry-After: 1 (until its 60 s run out)', async () => {
    const { api, advance, call, login } = await env();
    const token = await login('zarya.head@agrotrace.test');
    const body = waybillBody(api);
    const fingerprint = sha256hex(`POST /api/v1/waybills\n${JSON.stringify(body)}`);
    const key = `idem:${userOf(api, 'zarya.head@agrotrace.test').id}:r2-pend-00001`;
    api.store.kvSet(key, { fingerprint, state: 'pending' }, 60);
    const h = { 'Idempotency-Key': 'r2-pend-00001' };
    const busy = await call('POST', '/waybills', { token, json: body, headers: h });
    expect([busy.status, busy.body.code, busy.headers.get('Retry-After')]).toEqual([
      409,
      'IDEMPOTENCY_KEY_IN_PROGRESS',
      '1',
    ]);
    const other = await call('POST', '/waybills', { token, json: { ...body, items: [] }, headers: h });
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    advance(61_000);
    expect((await call('POST', '/waybills', { token, json: body, headers: h })).status).toBe(201);
  });
});

describe('visibility and uploads', () => {
  it('a DRAFT waybill does not make its sender visible to the receiver; a sent one does', async () => {
    const { api, call, login } = await env();
    const s = api.store;
    const zarya = orgOf(api, 'Заря');
    const receiver = s.t.organizations.find(
      (o) =>
        ['PROCESSOR', 'RETAILER'].includes(o.type) &&
        o.id !== zarya.id &&
        o.status === 'ACTIVE' &&
        s.t.users.some(
          (u) => u.organization_id === o.id && u.status === 'ACTIVE' && /@agrotrace\.test$/.test(u.email),
        ) &&
        !s.t.waybills.some(
          (w) =>
            (w.sender_org_id === zarya.id && w.receiver_org_id === o.id) ||
            (w.receiver_org_id === zarya.id && w.sender_org_id === o.id),
        ),
    )!;
    expect(receiver).toBeDefined();
    const rt = await login(
      s.t.users.find((u) => u.organization_id === receiver.id && u.status === 'ACTIVE')!.email,
    );
    expect((await call('GET', `/organizations/${zarya.id}`, { token: rt })).status).toBe(404);
    const zt = await login('zarya.head@agrotrace.test');
    const b = s.t.batches.find(
      (x) => x.holder_org_id === zarya.id && x.status === 'Approved' && x.deleted_at === null,
    )!;
    const wb = await call('POST', '/waybills', {
      token: zt,
      json: { receiverOrgId: receiver.id, items: [{ batchId: b.id, massDeclaredKg: b.mass_kg }] },
      headers: { 'Idempotency-Key': 'r2-draft-0001' },
    });
    expect(wb.status, JSON.stringify(wb.body)).toBe(201);
    expect((await call('GET', `/organizations/${zarya.id}`, { token: rt })).status).toBe(404);
    s.patch(s.get('waybills', wb.body.id)!, { status: 'SENT' });
    expect((await call('GET', `/organizations/${zarya.id}`, { token: rt })).status).toBe(200);
  });

  it('form errors (400) come before the size check (413)', async () => {
    const { call, login } = await env();
    const token = await login('petrov@agrotrace.test');
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    const extra = new FormData();
    extra.append('file', new File([big], 'a.webp'));
    extra.append('note', 'x');
    const r = await call('PUT', '/me/avatar', { token, form: extra });
    expect([r.status, r.body.errors]).toEqual([400, { note: ['validation.unknownField'] }]);
    const dup = new FormData();
    dup.append('file', new File([big], 'a.webp'));
    dup.append('file', new File([big], 'b.webp'));
    expect((await call('PUT', '/me/avatar', { token, form: dup })).status).toBe(400);
    const only = new FormData();
    only.append('file', new File([big], 'a.webp'));
    expect((await call('PUT', '/me/avatar', { token, form: only })).status).toBe(413);
  });
});
