/** Contract table freshness, the validator itself, rate limits, schedulers, persistence, generated files. */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { operationTable } from '../scripts/contract-table.js';
import { OPERATIONS } from '../src/contract/operations.generated.js';
import { createMockApi, DEMO_PASSWORD } from '../src/index.js';
import { readXlsx, writeXlsx } from '../src/lib/xlsx.js';
import { contractErrors } from './helpers/client.js';
import { nodeAssetLoader } from './helpers/assets.js';

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

describe('persistence', () => {
  it('a Storage snapshot restores the state (incl. uploads and the cookie jar) after a "reload"', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as Storage;
    const a = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader, persist: storage });
    const login = await (await a.handle(req('/auth/login', { method: 'POST', json: { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD } }))).json();
    const f = await a.handle(req('/fields', { method: 'POST', token: login.accessToken, json: { name: 'Сохранённое поле', areaHa: '1.00', regionCode: '33' } }));
    expect(f.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    a.dispose();
    const size = data.get('agrotrace-mock-api')!.length;
    expect(size).toBeLessThan(4_000_000);

    const b = createMockApi({ now: () => T0, loadAsset: nodeAssetLoader, persist: storage });
    await b.ready;
    expect(b.store.t.fields.some((x) => x.name === 'Сохранённое поле')).toBe(true);
    const refreshed = await b.handle(req('/auth/refresh', { method: 'POST' }));
    expect(refreshed.status).toBe(200);
    const protocol = b.store.t.files.find((x) => x.kind === 'LAB_PROTOCOL')!;
    expect(protocol.content.type === 'bytes' && protocol.content.data.length).toBeGreaterThan(1000);
    await b.reset();
    expect(data.has('agrotrace-mock-api')).toBe(false);
    expect(b.store.t.fields.some((x) => x.name === 'Сохранённое поле')).toBe(false);
    b.dispose();
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
