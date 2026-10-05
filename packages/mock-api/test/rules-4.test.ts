import { describe, expect, it } from 'vitest';
import { createMockApi, DEMO_PASSWORD, solveChallenge } from '../src/index.js';
import { readXlsx } from '../src/lib/xlsx.js';
import { BASE, expectStatus } from './helpers/client.js';
import { nodeAssetLoader } from './helpers/assets.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const s = () => mock.api.store;
const code = (n: number) => `AT-2026-${String(n).padStart(6, '0')}`;
const batch = (n: number) => s().t.batches.find((b) => b.public_code === code(n))!;
const org = (part: string) => s().t.organizations.find((o) => o.name.includes(part))!;
const as = (who: string) => mock.login(`${who}@agrotrace.test`);
const YEAR = 'from=2026-01-01&to=2026-12-31';
const statuses = (byStatus: { status: string; count: number }[]) =>
  byStatus
    .filter((x) => x.count)
    .map((x) => `${x.status}=${x.count}`)
    .join(' ');
const sheet = async (path: string, token: string, index = 0) =>
  readXlsx((await expectStatus(200, 'GET', path, { token })).bytes, index);
const col = (rows: { cells: unknown[] }[], i: number) => rows.map((r) => r.cells[i] ?? '');

describe('dashboards (seed world, 2026-10-14 10:00 UTC)', () => {
  it('inspector: batches, rejected shares by product and farm, active recalls, recall hours, violations by region', async () => {
    const d = (
      await expectStatus(200, 'GET', `/analytics/dashboard?scope=inspector&${YEAR}`, {
        token: await as('inspector'),
      })
    ).body;
    expect(d.batchesTotal).toBe(41);
    const share = (xs: { name: string; tested: number; failed: number; share: string }[]) =>
      xs.map((x) => `${x.name} ${x.failed}/${x.tested} ${x.share}`);
    expect(share(d.rejectedShare.byProduct)).toEqual([
      'Ячмень пивоваренный 1/2 50.00',
      'Молоко сырое коровье 1/6 16.67',
      'Капуста белокочанная 0/2 0.00',
      'Картофель продовольственный 0/2 0.00',
      'Пшеница мягкая 0/2 0.00',
      'Яблоки 0/2 0.00',
      'Говядина охлаждённая 0/1 0.00',
      'Морковь столовая 0/1 0.00',
      'Рапс 0/1 0.00',
    ]);
    expect(share(d.rejectedShare.byFarm)).toEqual([
      'ООО «Молочная ферма Луговая» 1/6 16.67',
      'ООО «Агрофирма Заря» 1/7 14.29',
      'КФХ Петров И.С. 0/6 0.00',
    ]);
    expect(d.activeRecalls).toBe(3);
    expect(d.avgRecallHours).toBe('25.50');
    expect(d.violationsByRegion.map((r: { code: string; count: number }) => `${r.code}:${r.count}`)).toEqual([
      '33:2',
      '37:0',
      '50:0',
      '52:0',
      '62:0',
      '76:0',
    ]);
  });

  it('inspector: byFarm counts raw batches of farms only (a processed batch of a farm origin is not a farm result)', async () => {
    const token = await as('inspector');
    const before = (await expectStatus(200, 'GET', `/analytics/dashboard?scope=inspector&${YEAR}`, { token }))
      .body.rejectedShare.byFarm;
    const zarya = org('Заря');
    const proto = batch(26);
    const derived = s().insert('batches', {
      ...structuredClone(proto),
      id: '00000000-0000-4000-8000-0000000f0001',
      public_code: 'AT-2026-990001',
      kind: 'DERIVED',
      origin_org_id: zarya.id,
    });
    const test = s().t.lab_tests.find((t) => t.batch_id === proto.id && t.status === 'DONE')!;
    s().insert('lab_tests', {
      ...structuredClone(test),
      id: '00000000-0000-4000-8000-0000000f0002',
      batch_id: derived.id,
      conclusion: 'FAIL',
    });
    const after = (await expectStatus(200, 'GET', `/analytics/dashboard?scope=inspector&${YEAR}`, { token }))
      .body.rejectedShare.byFarm;
    expect(after).toEqual(before);
    s().remove('lab_tests', s().get('lab_tests', '00000000-0000-4000-8000-0000000f0002')!);
    s().remove('batches', derived);
  });

  it('the window: default the last 30 days ending today; at most 366 days', async () => {
    const token = await as('inspector');
    const d = (await expectStatus(200, 'GET', '/analytics/dashboard?scope=inspector', { token })).body;
    expect(d.period).toEqual({ from: '2026-09-15', to: '2026-10-14' });
    expect(d.batchesTotal).toBe(13);
    expect(
      (await expectStatus(200, 'GET', '/analytics/dashboard?scope=inspector&to=2026-10-01', { token })).body
        .period,
    ).toEqual({ from: '2026-09-02', to: '2026-10-01' });
    await expectStatus(200, 'GET', '/analytics/dashboard?scope=inspector&from=2025-10-14&to=2026-10-14', {
      token,
    });
    const long = await expectStatus(
      400,
      'GET',
      '/analytics/dashboard?scope=inspector&from=2025-10-13&to=2026-10-14',
      { token },
    );
    expect(long.body.errors).toEqual({ from: ['validation.range.tooLong'] });
  });

  it('org: batches held by status, own lab results, open and overdue recall tasks', async () => {
    const expected: Record<string, [string, { pass: number; fail: number }, number, number]> = {
      'molkombinat.head': ['Approved=1 Accepted=1 Processed=9 Recalled=2', { pass: 0, fail: 0 }, 1, 1],
      'zarya.head': ['OnTest=1 Approved=3 InTransit=1 Recalled=1', { pass: 6, fail: 1 }, 1, 0],
      'provizia.head': ['OnSale=2 Sold=3 Recalled=1 WrittenOff=2', { pass: 0, fail: 0 }, 1, 0],
      'koltso.head': ['OnSale=2 Recalled=1', { pass: 0, fail: 0 }, 2, 1],
      'lugovaya.head': ['OnTest=1', { pass: 5, fail: 1 }, 0, 0],
      'melkombinat.head': ['Approved=1 Accepted=1 Processed=1', { pass: 0, fail: 0 }, 0, 0],
      'lavka.head': ['OnSale=1 Sold=3 Recalled=1', { pass: 0, fail: 0 }, 1, 1],
    };
    for (const [who, [byStatus, labResults, openTasks, overdueTasks]] of Object.entries(expected)) {
      const d = (
        await expectStatus(200, 'GET', `/analytics/dashboard?scope=org&${YEAR}`, { token: await as(who) })
      ).body;
      expect([statuses(d.byStatus), d.labResults, d.openTasks, d.overdueTasks], who).toEqual([
        byStatus,
        labResults,
        openTasks,
        overdueTasks,
      ]);
    }
  });

  it('lab: queue (open tests only), overdue, completed, failed, average hours', async () => {
    const pick = (d: Record<string, unknown>) => [d.queue, d.overdue, d.completed, d.failed, d.avgHours];
    expect(
      pick(
        (
          await expectStatus(200, 'GET', `/analytics/dashboard?scope=lab&${YEAR}`, {
            token: await as('agrotest.head'),
          })
        ).body,
      ),
    ).toEqual([2, 1, 16, 2, '33.27']);
    expect(
      pick(
        (
          await expectStatus(200, 'GET', `/analytics/dashboard?scope=lab&${YEAR}`, {
            token: await as('vetlab.head'),
          })
        ).body,
      ),
    ).toEqual([2, 0, 3, 0, '54.00']);
  });
});

describe('report contents', () => {
  it('batches: a head sees the batches it created or holds, by code, creator then holder', async () => {
    const r = await sheet(`/reports/batches?format=xlsx&${YEAR}`, await as('zarya.head'));
    expect(col(r.rows, 0)).toEqual([
      'AT-2026-000018',
      'AT-2026-000023',
      'AT-2026-000026',
      'AT-2026-000028',
      'AT-2026-000031',
      'AT-2026-000035',
      'AT-2026-000037',
      'AT-2026-000038',
      'AT-2026-000041',
    ]);
    expect(r.rows[0]!.cells.slice(6, 8)).toEqual(['ООО «Агрофирма Заря»', 'ООО «Мелькомбинат Владимирский»']);
  });

  it('lab-tests: a lab head sees its own lab; "overdue" only for open tests past due', async () => {
    const r = await sheet(`/reports/lab-tests?format=xlsx&${YEAR}`, await as('agrotest.head'));
    expect(r.rows).toHaveLength(18);
    expect(new Set(col(r.rows, 2))).toEqual(new Set(['ООО «Испытательный центр АгроТест»']));
    expect(r.rows.filter((x) => x.cells[10] === 'да').map((x) => [x.cells[0], x.cells[4]])).toEqual([
      ['AT-2026-000036', 'ESCALATED'],
    ]);
    const all = await sheet(`/reports/lab-tests?format=xlsx&${YEAR}`, await as('inspector'));
    expect(all.rows).toHaveLength(23);
  });

  it('recall: the timeline in time order, the opening before the task at the same minute', async () => {
    const closed = s().t.recalls.find((r) => r.status === 'CLOSED')!;
    const timeline = await sheet(`/reports/recall?format=xlsx&id=${closed.id}`, await as('inspector'), 3);
    expect(timeline.rows.map((r) => r.cells.slice(0, 2).join(' '))).toEqual([
      '2026-09-22 11:00 RECALL_OPENED',
      '2026-09-22 11:00 TASK_CREATED',
      '2026-09-23 11:05 TASK_OVERDUE',
      '2026-09-23 12:30 TASK_CONFIRMED',
      '2026-09-23 12:30 RECALL_CLOSED',
    ]);
  });

  it('org: a head may not ask for another organization', async () => {
    const zarya = await as('zarya.head');
    const r = await expectStatus(400, 'GET', `/reports/org?format=xlsx&${YEAR}&id=${org('Луговая').id}`, {
      token: zarya,
    });
    expect(r.body.errors).toEqual({ id: ['validation.id.notAllowed'] });
    await expectStatus(200, 'GET', `/reports/org?format=xlsx&${YEAR}&id=${org('Заря').id}`, { token: zarya });
  });
});

describe('public page', () => {
  it('the latest lab test is the last completed one; a Blocked batch shows BLOCKED', async () => {
    const page = (await expectStatus(200, 'GET', `/public/batches/${code(10)}`)).body;
    expect(page.labSummary).toEqual({
      total: 2,
      passed: 1,
      lastConclusion: 'FAIL',
      lastDate: '2026-10-12T15:20:00Z',
    });
    const b = batch(26);
    s().patch(b, { status: 'Blocked' });
    expect((await expectStatus(200, 'GET', `/public/batches/${code(26)}`)).body.safety).toBe('BLOCKED');
    s().patch(b, { status: 'Approved' });
  });
});

describe('permissions and rules the frontends handle', () => {
  it('invite: a head invites only into its own organization', async () => {
    const r = await expectStatus(400, 'POST', '/users', {
      token: await as('zarya.head'),
      body: {
        email: 'new.person@agrotrace.test',
        fullName: 'Новый Человек',
        roles: ['FARMER'],
        isOrgAdmin: false,
        organizationId: org('Луговая').id,
      },
    });
    expect(r.body.errors).toEqual({ organizationId: ['validation.organizationId.notAllowed'] });
  });

  it('processing: not the holder → 403 NOT_HOLDER; a Recalled input → 422 BR-06', async () => {
    const mol = await as('molkombinat.head');
    const product = s().t.products.find((p) => p.category === 'PROCESSED')!;
    const notMine = s().t.batches.find(
      (b) =>
        b.origin_org_id === org('Молкомбинат').id &&
        b.holder_org_id !== org('Молкомбинат').id &&
        b.status === 'OnSale',
    )!;
    const r403 = await expectStatus(403, 'POST', '/processing', {
      token: mol,
      body: {
        inputs: [{ batchId: notMine.id, massUsedKg: '1.000' }],
        outputs: [{ productId: product.id, massKg: '0.500' }],
      },
    });
    expect(r403.body.params).toEqual({ reason: 'NOT_HOLDER', publicCode: notMine.public_code });
    const recalled = s().t.batches.find(
      (b) => b.holder_org_id === org('Молкомбинат').id && b.status === 'Recalled',
    )!;
    const r422 = await expectStatus(422, 'POST', '/processing', {
      token: mol,
      body: {
        inputs: [{ batchId: recalled.id, massUsedKg: '1.000' }],
        outputs: [{ productId: product.id, massKg: '0.500' }],
      },
    });
    expect([r422.body.rule, r422.body.params]).toEqual([
      'BR-06',
      { publicCode: recalled.public_code, status: 'Recalled' },
    ]);
  });

  it('organizations list: active participants only, name prefix or INN prefix', async () => {
    const token = await as('inspector');
    const names = async (q: string) =>
      (await expectStatus(200, 'GET', `/organizations?size=100${q}`, { token })).body.items.map(
        (o: { name: string }) => o.name,
      );
    expect(await names('')).toHaveLength(11);
    const lavka = org('лавка');
    s().patch(lavka, { status: 'SUSPENDED' });
    expect(await names('')).not.toContain(lavka.name);
    s().patch(lavka, { status: 'ACTIVE' });
    expect(await names(`&q=${encodeURIComponent('Заря')}`)).toEqual([]);
    expect(await names(`&q=${encodeURIComponent('ооо «агро')}`)).toEqual(['ООО «Агрофирма Заря»']);
    expect(await names('&q=2312')).toEqual(['ООО «Агрофирма Заря»']);
  });

  it('mark read: only the caller’s notifications, and the caller’s streams get the new unread count', async () => {
    const insp = await as('inspector');
    const me = s().t.users.find((u) => u.email === 'inspector@agrotrace.test')!;
    const othersUnread = () => s().t.notifications.filter((n) => n.user_id !== me.id && !n.is_read).length;
    const before = othersUnread();
    expect(before).toBeGreaterThan(0);
    const res = await mock.api.handle(new Request(`${BASE}/events/stream?access_token=${insp}`));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toMatch(/^event: unread\ndata: \{"count":[1-9]/);
    const r = await expectStatus(200, 'POST', '/notifications/read', {
      token: insp,
      body: { upToSeq: s().seq.notification },
    });
    expect(r.body.count).toBe(0);
    expect(othersUnread()).toBe(before);
    expect(dec.decode((await reader.read()).value)).toBe('event: unread\ndata: {"count":0}\n\n');
    await reader.cancel();
  });

  it('recalls: the list filters by status; confirming the last task closes the recall (new version, RECALL CLOSED to inspectors)', async () => {
    const insp = await as('inspector');
    const closed = await expectStatus(200, 'GET', '/recalls?status=CLOSED&size=100', { token: insp });
    expect(closed.body.items.map((r: { status: string }) => r.status)).toEqual(['CLOSED']);
    const open = await expectStatus(200, 'GET', '/recalls?status=OPEN&size=100', { token: insp });
    expect(open.body.total).toBe(3);

    const recall = s().t.recalls.find((r) => r.source_batch_id === batch(41).id)!;
    const task = s().t.recall_tasks.find((t) => t.recall_id === recall.id)!;
    const version = recall.version;
    const seq = s().seq.notification;
    await expectStatus(200, 'POST', `/recall-tasks/${task.id}/confirm`, {
      token: await as('zarya.head'),
      headers: { 'If-Match': String(task.version), 'Idempotency-Key': 'r4-close-00001' },
    });
    expect([recall.status, recall.version]).toEqual(['CLOSED', version + 1]);
    const inspectors = s()
      .t.users.filter((u) => u.roles.includes('INSPECTOR') && u.status === 'ACTIVE' && u.deleted_at === null)
      .map((u) => u.id)
      .sort();
    const closedTo = s()
      .t.notifications.filter(
        (n) =>
          n.seq > seq &&
          n.type === 'RECALL' &&
          n.payload.event === 'CLOSED' &&
          n.payload.recallId === recall.id,
      )
      .map((n) => n.user_id)
      .sort();
    expect(closedTo).toEqual(inspectors);
  });

  it('complaint: the contact is kept for the inspector', async () => {
    const challenge = await expectStatus(200, 'GET', '/public/captcha');
    const created = await expectStatus(201, 'POST', `/public/batches/${code(28)}/complaints`, {
      body: {
        text: 'Яблоки мятые и с гнилью.',
        contact: '+7 900 000-00-00',
        altcha: solveChallenge(challenge.body),
      },
    });
    const card = await expectStatus(200, 'GET', `/complaints/${created.body.id}`, {
      token: await as('inspector'),
    });
    expect(card.body.contact).toBe('+7 900 000-00-00');
  });

  it('dictionary import: errors of a row sorted by column; an unchanged row is unchanged; a soft-deleted row is restored', async () => {
    const admin = await as('admin');
    const form = (csv: string) => {
      const f = new FormData();
      f.append('file', new File([new TextEncoder().encode(csv)], 's.csv'));
      return f;
    };
    const sub = s().t.substances.find((x) => x.deleted_at === null)!;
    const line = `${sub.name};${sub.type};${sub.waiting_period_days}`;
    const unchanged = await expectStatus(200, 'POST', '/dictionaries/substances/import', {
      token: admin,
      form: form(`name;type;waitingPeriodDays\n${line}`),
    });
    expect(unchanged.body).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const sorted = await expectStatus(200, 'POST', '/dictionaries/substances/import', {
      token: admin,
      form: form(`name;type;waitingPeriodDays\nДубль;PESTICIDE;1\nДубль;XXX;1`),
    });
    expect(sorted.body.errors).toEqual([
      { row: 3, column: 'name', message: 'validation.duplicate' },
      { row: 3, column: 'type', message: 'validation.enum' },
    ]);
    await expectStatus(204, 'DELETE', `/dictionaries/substances/${sub.id}`, { token: admin });
    expect(sub.deleted_at).not.toBeNull();
    const restored = await expectStatus(200, 'POST', '/dictionaries/substances/import', {
      token: admin,
      form: form(`name;type;waitingPeriodDays\n${line}`),
    });
    expect(restored.body).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(sub.deleted_at).toBeNull();
  });
});

describe('limits and lifetimes', () => {
  it('complaints: the 11th public complaint of an hour from one address is 429 (complaint-ip)', async () => {
    const api = createMockApi({
      now: () => Date.parse('2026-10-14T10:00:30Z'),
      loadAsset: nodeAssetLoader,
      persist: false,
      rateLimits: true,
    });
    await api.ready;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const challenge = await (await api.handle(new Request(`${BASE}/public/captcha`))).json();
      const r = await api.handle(
        new Request(`${BASE}/public/batches/${code(28)}/complaints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Жалоба номер ${i} на партию.`, altcha: solveChallenge(challenge) }),
        }),
      );
      statuses.push(r.status);
    }
    expect(statuses).toEqual([...Array(10).fill(201), 429]);
    api.dispose();
    expect(DEMO_PASSWORD).toBeTruthy();
  });

  it('signed file URLs live one hour: valid at 59 min, 403 after the hour', async () => {
    const me = await expectStatus(200, 'GET', '/me', { token: await as('petrov') });
    const url = (me.body.avatarUrl as string).replace('/api/v1', '');
    const exp = Number(/exp=(\d+)/.exec(url)![1]);
    expect(exp).toBe(Math.floor(mock.now() / 1000) + 3600);
    mock.advance(59 * 60_000);
    await expectStatus(200, 'GET', url);
    mock.advance(2 * 60_000);
    await expectStatus(403, 'GET', url);
  });
});
