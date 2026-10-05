import { describe, expect, it } from 'vitest';
import rules from '../../../contracts/rules/notifications.json' with { type: 'json' };
import { insertBytesFile } from '../src/domain/files.js';
import { BASE, call, expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const s = () => mock.api.store;
const code = (n: number) => `AT-2026-${String(n).padStart(6, '0')}`;
const batch = (n: number) => s().t.batches.find((b) => b.public_code === code(n))!;
const org = (part: string) => s().t.organizations.find((o) => o.name.includes(part))!;
const user = (email: string) => s().t.users.find((u) => u.email === email)!;
const activeUsers = (pred: (u: ReturnType<typeof user>) => boolean) =>
  s().t.users.filter((u) => u.status === 'ACTIVE' && u.deleted_at === null && pred(u)).map((u) => u.id).sort();
const recipients = (type: string, pred: (p: Record<string, unknown>) => boolean) =>
  [...new Set(s().t.notifications.filter((n) => n.type === type && pred(n.payload)).map((n) => n.user_id))].sort();
const inspectors = () => activeUsers((u) => u.roles.includes('INSPECTOR'));
const ofOrgs = (...ids: string[]) => activeUsers((u) => ids.includes(u.organization_id));
const labUser = (labOrgId: string) => (org('Клязьма').id === labOrgId ? 'vetlab.analyst@agrotrace.test' : 'agrotest.head@agrotrace.test');
const iso = (ms: number) => new Date(ms).toISOString();

async function passTest(testId: string, fail = false): Promise<Record<string, unknown>> {
  const t = s().t.lab_tests.find((x) => x.id === testId)!;
  const token = await mock.login(labUser(t.lab_org_id));
  const card = await expectStatus(200, 'GET', `/lab-tests/${testId}`, { token });
  const results = card.body.norms.map((n: { indicatorId: string }, i: number) => ({ indicatorId: n.indicatorId, value: fail && i === 0 ? '999' : '0' }));
  return (await expectStatus(200, 'POST', `/lab-tests/${testId}/results`, { token, headers: { 'If-Match': String(card.body.version) }, body: { results } })).body;
}

describe('protocol', () => {
  it('a handler that writes and then fails leaves no partial state (rollback)', async () => {
    const t = await mock.login('melkombinat.head@agrotrace.test');
    const flour = s().t.products.find((p) => p.category === 'PROCESSED')!;
    const counts = () => [s().t.batches.length, s().t.batch_links.length, s().t.batch_status_history.length, s().t.audit_log.length];
    const before = counts();
    const statusBefore = batch(23).status;
    const r = await call('POST', '/processing', { token: t, body: { inputs: [{ batchId: batch(23).id, massUsedKg: '100.000' }, { batchId: batch(18).id, massUsedKg: '1.000' }], outputs: [{ productId: flour.id, massKg: '50.000' }] } });
    expect(r.status).toBe(422);
    expect(counts()).toEqual(before);
    expect(batch(23).status).toBe(statusBefore);
    const rows = s().t.fields.length;
    await expect(
      s().runAsync('probe', null, async () => {
        s().insert('fields', { ...s().t.fields[0]!, id: '00000000-0000-4000-8000-00000000ffff' });
        s().patch(s().t.fields[0]!, { name: 'changed' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(s().t.fields.length).toBe(rows);
    expect(s().t.fields[0]!.name).not.toBe('changed');
    expect(s().get('fields', '00000000-0000-4000-8000-00000000ffff')).toBeUndefined();
  });

  it('SSE replays exactly the notifications after Last-Event-ID; the header wins over the query', async () => {
    const t = await mock.login('inspector@agrotrace.test');
    const own = s().t.notifications.filter((n) => n.user_id === user('inspector@agrotrace.test').id).sort((a, b) => a.seq - b.seq);
    const pivot = own[own.length - 3]!.seq;
    const read = async (req: Request) => {
      const res = await mock.api.handle(req);
      const reader = res.body!.getReader();
      let text = '';
      while (!text.includes('event: unread')) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    };
    expect(await read(new Request(`${BASE}/events/stream?access_token=${t}&lastEventId=${pivot}`))).toEqual(own.filter((n) => n.seq > pivot).map((n) => n.seq));
    expect(await read(new Request(`${BASE}/events/stream?access_token=${t}&lastEventId=1`, { headers: { 'Last-Event-ID': String(own.at(-1)!.seq) } }))).toEqual([]);
    expect(await read(new Request(`${BASE}/events/stream?access_token=${t}`))).toEqual([]);
  });

  it('logout revokes the refresh token; blocking a user revokes theirs', async () => {
    const login = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'koltso.head@agrotrace.test', password: 'agrotrace-demo' } });
    const cookie = /at_refresh=([^;]+)/.exec(login.headers.get('set-cookie')!)![1]!;
    await expectStatus(204, 'POST', '/auth/logout', { headers: { cookie: `at_refresh=${cookie}` } });
    expect((await call('POST', '/auth/refresh', { headers: { cookie: `at_refresh=${cookie}` } })).status).toBe(401);

    const agr = await expectStatus(200, 'POST', '/auth/login', { body: { email: 'molkombinat.technolog@agrotrace.test', password: 'agrotrace-demo' } });
    const c2 = /at_refresh=([^;]+)/.exec(agr.headers.get('set-cookie')!)![1]!;
    const head = await mock.login('molkombinat.head@agrotrace.test');
    await expectStatus(200, 'PATCH', `/users/${user('molkombinat.technolog@agrotrace.test').id}`, { token: head, body: { status: 'BLOCKED' } });
    await expectStatus(200, 'PATCH', `/users/${user('molkombinat.technolog@agrotrace.test').id}`, { token: head, body: { status: 'ACTIVE' } });
    const r = await call('POST', '/auth/refresh', { headers: { cookie: `at_refresh=${c2}` } });
    expect(r.status).toBe(401);
  });

  it('a REPORT file is readable by its owner only', async () => {
    const owner = user('inspector@agrotrace.test');
    const f = s().run('probe', null, () =>
      insertBytesFile(s(), { kind: 'REPORT', originalName: 'r.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4 x'), ownerId: owner.id }),
    );
    await expectStatus(200, 'GET', `/files/${f.id}`, { token: await mock.login(owner.email) });
    await expectStatus(404, 'GET', `/files/${f.id}`, { token: await mock.login('admin@agrotrace.test') });
  });

  it('the audit log filters by backend', async () => {
    const admin = await mock.login('admin@agrotrace.test');
    const seed = await expectStatus(200, 'GET', '/audit-log?backend=seed&size=100', { token: admin });
    expect(seed.body.items.every((a: { backend: string }) => a.backend === 'seed')).toBe(true);
    const ex = await expectStatus(200, 'GET', '/audit-log?backend=express&size=100', { token: admin });
    expect(ex.body.items.every((a: { backend: string }) => a.backend === 'express')).toBe(true);
    expect(ex.body.total).toBeGreaterThan(0);
    expect(ex.body.total + seed.body.total).toBe(s().t.audit_log.length);
  });
});

describe('recall propagation (tag Recalls, steps 2–7)', () => {
  it('DOWN members, depths, statusBefore, Recalled only where recallable, tasks and holders, UP without tasks, notifications', async () => {
    const zarya = await mock.login('zarya.head@agrotrace.test');
    const mel = await mock.login('melkombinat.head@agrotrace.test');
    const apples = batch(31);
    const wb = await expectStatus(201, 'POST', '/waybills', { token: zarya, headers: { 'Idempotency-Key': 'rp-wb-000001' }, body: { receiverOrgId: org('Мелькомбинат').id, items: [{ batchId: apples.id, massDeclaredKg: apples.mass_kg }] } });
    await expectStatus(200, 'POST', `/waybills/${wb.body.id}/send`, { token: zarya, headers: { 'If-Match': '1', 'Idempotency-Key': 'rp-send-00001' } });
    expect(recipients('WAYBILL_INCOMING', (p) => p.waybillId === wb.body.id)).toEqual(ofOrgs(org('Мелькомбинат').id));
    await expectStatus(200, 'POST', `/waybills/${wb.body.id}/accept`, { token: mel, headers: { 'If-Match': '2', 'Idempotency-Key': 'rp-acc-000001' }, body: { items: [{ batchId: apples.id, massActualKg: apples.mass_kg }] } });
    const flour = s().t.products.find((p) => p.category === 'PROCESSED')!;
    const p1 = await expectStatus(201, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: apples.id, massUsedKg: '1000.000' }], outputs: [{ productId: flour.id, massKg: '400.000' }, { productId: flour.id, massKg: '400.000' }] } });
    const [a, b] = p1.body.outputs as { id: string; publicCode: string }[];
    const wb2 = await expectStatus(201, 'POST', '/waybills', { token: mel, headers: { 'Idempotency-Key': 'rp-wb-000002' }, body: { receiverOrgId: org('Провизия').id, items: [{ batchId: a!.id, massDeclaredKg: '400.000' }] } });
    await expectStatus(200, 'POST', `/waybills/${wb2.body.id}/send`, { token: mel, headers: { 'If-Match': '1', 'Idempotency-Key': 'rp-send-00002' } });
    const p2 = await expectStatus(201, 'POST', '/processing', { token: mel, body: { inputs: [{ batchId: b!.id, massUsedKg: '400.000' }], outputs: [{ productId: flour.id, massKg: '300.000' }] } });
    const c = p2.body.outputs[0] as { id: string; publicCode: string };

    const insp = await mock.login('inspector@agrotrace.test');
    const r = await expectStatus(201, 'POST', '/recalls', { token: insp, body: { sourceBatchId: apples.id, reason: 'Проверка', blockUpstream: false } });
    const members = Object.fromEntries(
      r.body.batches.map((x: { batch: { id: string; status: string }; direction: string; depth: number; statusBefore: string }) => [x.batch.id, [x.direction, x.depth, x.statusBefore, x.batch.status]]),
    );
    expect(members).toEqual({
      [apples.id]: ['SOURCE', 0, 'Processed', 'Processed'],
      [a!.id]: ['DOWN', 1, 'InTransit', 'Recalled'],
      [b!.id]: ['DOWN', 1, 'Processed', 'Processed'],
      [c.id]: ['DOWN', 2, 'Approved', 'Recalled'],
    });
    const tasks = Object.fromEntries(r.body.tasks.map((t: { batch: { id: string }; holder: { id: string } }) => [t.batch.id, t.holder.id]));
    expect(tasks).toEqual({ [a!.id]: org('Провизия').id, [c.id]: org('Мелькомбинат').id });
    expect(r.body.status).toBe('OPEN');
    expect(recipients('RECALL', (p) => p.recallId === r.body.id && p.event === 'OPENED')).toEqual(
      [...new Set([...inspectors(), ...ofOrgs(org('Провизия').id, org('Мелькомбинат').id, org('Заря').id)])].sort(),
    );
    expect(recipients('RECALL_TASK', (p) => p.recallId === r.body.id)).toEqual(ofOrgs(org('Провизия').id, org('Мелькомбинат').id));

    const up = await expectStatus(201, 'POST', '/recalls', { token: insp, body: { sourceBatchId: c.id, reason: 'Вверх', blockUpstream: true } });
    const upMembers = up.body.batches.map((x: { batch: { id: string }; direction: string; depth: number }) => [x.batch.id, x.direction, x.depth]);
    expect(upMembers).toEqual(expect.arrayContaining([[c.id, 'SOURCE', 0], [b!.id, 'UP', 1], [apples.id, 'UP', 2]]));
    expect(upMembers.some((m: string[]) => m[0] === a!.id)).toBe(false);
    expect(up.body.tasks).toEqual([]);
    expect(up.body.status).toBe('CLOSED');
    expect(recipients('RECALL', (p) => p.recallId === up.body.id)).toEqual(inspectors());
    const down = await expectStatus(201, 'POST', '/recalls', { token: insp, body: { sourceBatchId: b!.id, reason: 'Без вверх', blockUpstream: false } });
    expect(down.body.batches.some((x: { direction: string }) => x.direction === 'UP')).toBe(false);
  });
});

describe('batch rules', () => {
  it('BR-01 params: the first allowed date and the substance of the latest waiting period', async () => {
    const t = await mock.login('zarya.agronom@agrotrace.test');
    const field = await expectStatus(201, 'POST', '/fields', { token: t, body: { name: 'BR-01 поле', areaHa: '5.00', regionCode: '33' } });
    const decis = s().t.substances.find((x) => x.name.startsWith('Децис'))!;
    const roundup = s().t.substances.find((x) => x.name.startsWith('Раундап'))!;
    const applied = mock.now() - 2 * 86_400_000;
    for (const sub of [decis, roundup])
      await expectStatus(201, 'POST', `/fields/${field.body.id}/treatments`, { token: t, body: { substanceId: sub.id, dose: '1.000', doseUnit: 'л/га', appliedAt: iso(applied) } });
    const wheat = s().t.products.find((p) => p.name === 'Пшеница мягкая')!;
    const b = await expectStatus(201, 'POST', '/batches', { token: t, body: { fieldId: field.body.id, productId: wheat.id, massKg: '100.000', harvestedAt: iso(mock.now() - 3600_000) } });
    await passTest(s().t.lab_tests.find((x) => x.batch_id === b.body.id)!.id);
    const wb = await expectStatus(201, 'POST', '/waybills', { token: t, headers: { 'Idempotency-Key': 'br01-wb-0001' }, body: { receiverOrgId: org('Мелькомбинат').id, items: [{ batchId: b.body.id, massDeclaredKg: '100.000' }] } });
    const r = await expectStatus(422, 'POST', `/waybills/${wb.body.id}/send`, { token: t, headers: { 'If-Match': '1', 'Idempotency-Key': 'br01-send-001' } });
    const until = new Date(Date.parse(iso(applied).slice(0, 10)) + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(r.body).toMatchObject({ code: 'BUSINESS_RULE', rule: 'BR-01', params: { publicCode: b.body.publicCode, until, substance: decis.name } });
  });

  it('risk model: LOW_RATING, NEW_FARM, RECENT_PESTICIDE; the regional lab first; NO_LAB_AVAILABLE', async () => {
    const wheat = s().t.products.find((p) => p.name === 'Пшеница мягкая')!;
    const harvested = iso(mock.now() - 3600_000);
    const create = async (token: string, fieldId: string) =>
      (await expectStatus(201, 'POST', '/batches', { token, body: { fieldId, productId: wheat.id, massKg: '10.000', harvestedAt: harvested } })).body;

    const zarya = await mock.login('zarya.agronom@agrotrace.test');
    const zf = (await expectStatus(200, 'GET', '/fields', { token: zarya })).body.items[0].id;
    expect((await create(zarya, zf)).testReason).toBe('LOW_RATING');

    const petrov = await mock.login('petrov@agrotrace.test');
    const pf = await expectStatus(201, 'POST', '/fields', { token: petrov, body: { name: 'Чистое поле', areaHa: '3.00', regionCode: '33' } });
    expect((await create(petrov, pf.body.id)).testReason).toMatch(/^(NONE|SAMPLED)$/);
    await expectStatus(201, 'POST', '/auth/register-organization', {
      body: { inn: '7707083893', type: 'FARM', name: 'КФХ Новое', regionCode: '33', admin: { email: 'new.farm@agrotrace.test', fullName: 'Новый Фермер', password: 'Password-2026' } },
    });
    const admin0 = await mock.login('admin@agrotrace.test');
    const newOrg = org('КФХ Новое');
    await expectStatus(200, 'POST', `/admin/organizations/${newOrg.id}/approve`, { token: admin0 });
    const nf = (await expectStatus(200, 'POST', '/auth/login', { body: { email: 'new.farm@agrotrace.test', password: 'Password-2026' } })).body.accessToken as string;
    const nfField = await expectStatus(201, 'POST', '/fields', { token: nf, body: { name: 'Первое поле', areaHa: '1.00', regionCode: '33' } });
    expect((await create(nf, nfField.body.id)).testReason).toBe('NEW_FARM');
    const aktara = s().t.substances.find((x) => x.name.startsWith('Актара'))!;
    await expectStatus(201, 'POST', `/fields/${pf.body.id}/treatments`, { token: petrov, body: { substanceId: aktara.id, dose: '0.080', doseUnit: 'кг/га', appliedAt: iso(mock.now() - 86_400_000) } });
    expect((await create(petrov, pf.body.id)).testReason).toBe('RECENT_PESTICIDE');

    const admin = await mock.login('admin@agrotrace.test');
    const agrotest = org('АгроТест');
    await expectStatus(200, 'PATCH', `/admin/organizations/${agrotest.id}`, { token: admin, body: { regionCode: '50' } });
    const f50 = await expectStatus(201, 'POST', '/fields', { token: zarya, body: { name: 'Поле 50', areaHa: '2.00', regionCode: '50' } });
    const f33 = await expectStatus(201, 'POST', '/fields', { token: zarya, body: { name: 'Поле 33', areaHa: '2.00', regionCode: '33' } });
    const load = (id: string) => s().t.lab_tests.filter((x) => x.lab_org_id === id && ['QUEUED', 'SAMPLED', 'ESCALATED'].includes(x.status)).length;
    for (let i = 0; i < 3; i++) await create(zarya, f50.body.id);
    expect(load(agrotest.id)).toBeGreaterThan(load(org('Клязьма').id));
    const b50 = await create(zarya, f50.body.id);
    expect(s().t.lab_tests.find((x) => x.batch_id === b50.id)!.lab_org_id).toBe(agrotest.id);
    const b33 = await create(zarya, f33.body.id);
    expect(s().t.lab_tests.find((x) => x.batch_id === b33.id)!.lab_org_id).toBe(org('Клязьма').id);

    for (const lab of [agrotest, org('Клязьма')]) await expectStatus(200, 'PATCH', `/admin/organizations/${lab.id}`, { token: admin, body: { status: 'SUSPENDED' } });
    const seq = s().seq.batch;
    const count = s().t.batches.length;
    const r = await expectStatus(409, 'POST', '/batches', { token: zarya, body: { fieldId: zf, productId: wheat.id, massKg: '10.000', harvestedAt: harvested } });
    expect(r.body).toEqual({ type: '/problems/no-lab-available', title: 'No laboratory available', status: 409, code: 'NO_LAB_AVAILABLE' });
    expect(s().t.batches.length).toBe(count);
    expect(s().seq.batch).toBe(seq + 1);
    for (const lab of [agrotest, org('Клязьма')])
      await expectStatus(200, 'PATCH', `/admin/organizations/${lab.id}`, { token: admin, body: { status: 'ACTIVE', regionCode: '33' } });
  });
});

describe('notification recipients (contracts/rules/notifications.json)', () => {
  it('LAB_RESULT: origin + holder (≠ origin) + inspectors only for unplanned tests; RECALL_TASK REASSIGNED to the sender', async () => {
    expect(rules.types.LAB_RESULT.recipients).toEqual(['batchOrigin', 'batchHolder', 'inspectorsIfUnplanned']);
    const insp = await mock.login('inspector@agrotrace.test');
    const milk = batch(2);
    const test = await expectStatus(201, 'POST', '/lab-tests', { token: insp, body: { batchId: milk.id, labOrgId: org('Клязьма').id } });
    expect(recipients('LAB_ASSIGNED', (p) => p.labTestId === test.body.id)).toEqual(ofOrgs(org('Клязьма').id, milk.origin_org_id));
    await passTest(test.body.id);
    expect(recipients('LAB_RESULT', (p) => p.labTestId === test.body.id)).toEqual(
      [...new Set([...ofOrgs(milk.origin_org_id, milk.holder_org_id), ...inspectors()])].sort(),
    );
    const zarya = await mock.login('zarya.agronom@agrotrace.test');
    const zf = (await expectStatus(200, 'GET', '/fields', { token: zarya })).body.items[0].id;
    const wheat = s().t.products.find((p) => p.name === 'Пшеница мягкая')!;
    const b = await expectStatus(201, 'POST', '/batches', { token: zarya, body: { fieldId: zf, productId: wheat.id, massKg: '20.000', harvestedAt: iso(mock.now() - 3600_000) } });
    const risk = s().t.lab_tests.find((x) => x.batch_id === b.body.id)!;
    await passTest(risk.id);
    expect(recipients('LAB_RESULT', (p) => p.labTestId === risk.id)).toEqual(ofOrgs(org('Заря').id));

    const koltso = await mock.login('koltso.head@agrotrace.test');
    const wb = s().t.waybills.find((w) => w.number === 'WB-2026-000027')!;
    await expectStatus(200, 'POST', `/waybills/${wb.id}/reject`, { token: koltso, headers: { 'If-Match': String(wb.version) }, body: { reason: 'Отозвана' } });
    const reassigned = s().t.notifications.filter((n) => n.type === 'RECALL_TASK' && n.payload.event === 'REASSIGNED');
    expect([...new Set(reassigned.map((n) => n.user_id))].sort()).toEqual(ofOrgs(wb.sender_org_id));
    const task = s().t.recall_tasks.find((x) => x.id === reassigned[0]!.payload.taskId)!;
    expect(task.holder_org_id).toBe(wb.sender_org_id);
  });
});
