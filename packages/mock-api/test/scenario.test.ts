import { describe, expect, it } from 'vitest';
import { expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const LAB_USER: Record<string, string> = {
  'АНО «Ветеринарный испытательный центр Клязьма»': 'vetlab.analyst@agrotrace.test',
  'ООО «Испытательный центр АгроТест»': 'agrotest.head@agrotrace.test',
};

describe('harvest → lab FAIL → recall → confirm → public page', () => {
  it('flows through the state', async () => {
    const farmer = await mock.login('zarya.agronom@agrotrace.test');
    const fields = await expectStatus(200, 'GET', '/fields', { token: farmer });
    const field = fields.body.items.find((f: { name: string }) => f.name)!;
    const products = await expectStatus(200, 'GET', '/dictionaries/products?q=%D0%AF%D1%87%D0%BC%D0%B5%D0%BD%D1%8C', { token: farmer });
    const barley = products.body.items[0];
    const harvestedAt = new Date(mock.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const created = await expectStatus(201, 'POST', '/batches', {
      token: farmer,
      body: { fieldId: field.id, productId: barley.id, massKg: '5200.000', harvestedAt },
    });
    const batch = created.body;
    expect(batch.status).toBe('OnTest');
    expect(batch.testReason).toBe('LOW_RATING');
    expect(batch.version).toBe(2);

    const tests = await expectStatus(200, 'GET', `/lab-tests?batchId=${batch.id}`, { token: farmer });
    expect(tests.body.total).toBe(1);
    const test = tests.body.items[0];
    const lab = await mock.login(LAB_USER[test.lab.name]!);
    const card = await expectStatus(200, 'GET', `/lab-tests/${test.id}`, { token: lab });
    expect(card.body.actions).toContain('submitResults');
    const results = card.body.norms.map((n: { indicatorId: string; maxValue: string }, i: number) => ({
      indicatorId: n.indicatorId,
      value: i === 0 ? '999' : '0',
    }));
    const done = await expectStatus(200, 'POST', `/lab-tests/${test.id}/results`, {
      token: lab,
      headers: { 'If-Match': String(card.body.version) },
      body: { results },
    });
    expect(done.body.conclusion).toBe('FAIL');
    expect(done.body.recallId).toBeTruthy();

    const recalled = await expectStatus(200, 'GET', `/batches/${batch.id}`, { token: farmer });
    expect(recalled.body.status).toBe('Recalled');
    expect(recalled.body.actions).toEqual([{ action: 'writeOff', to: 'WrittenOff' }]);
    const history = await expectStatus(200, 'GET', `/batches/${batch.id}/history`, { token: farmer });
    expect(history.body.map((h: { to: string }) => h.to)).toEqual(['Created', 'OnTest', 'Blocked', 'Recalled']);

    const inspector = await mock.login('inspector@agrotrace.test');
    const recall = await expectStatus(200, 'GET', `/recalls/${done.body.recallId}`, { token: inspector });
    expect(recall.body.trigger).toBe('LAB');
    expect(recall.body.status).toBe('OPEN');
    expect(recall.body.tasks).toHaveLength(1);

    const tasks = await expectStatus(200, 'GET', `/recall-tasks?recallId=${recall.body.id}`, { token: farmer });
    const task = tasks.body.items[0];
    const confirmed = await expectStatus(200, 'POST', `/recall-tasks/${task.id}/confirm`, {
      token: farmer,
      headers: { 'If-Match': String(task.version), 'Idempotency-Key': 'confirm-e2e-0001' },
    });
    expect(confirmed.body.status).toBe('CONFIRMED');
    const replay = await expectStatus(200, 'POST', `/recall-tasks/${task.id}/confirm`, {
      token: farmer,
      headers: { 'If-Match': String(task.version), 'Idempotency-Key': 'confirm-e2e-0001' },
    });
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');

    const closed = await expectStatus(200, 'GET', `/recalls/${recall.body.id}`, { token: inspector });
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.progress).toEqual({ confirmed: 1, total: 1, overdue: 0 });

    const page = await expectStatus(200, 'GET', `/public/batches/${batch.publicCode}`);
    expect(page.body.status).toBe('WrittenOff');
    expect(page.body.safety).toBe('RECALLED');
    expect(page.body.labSummary).toMatchObject({ total: 1, passed: 0, lastConclusion: 'FAIL' });

    const inbox = await expectStatus(200, 'GET', '/notifications?isRead=false&size=100', { token: farmer });
    const types = inbox.body.items.map((n: { type: string }) => n.type);
    expect(types).toEqual(expect.arrayContaining(['LAB_ASSIGNED', 'LAB_RESULT', 'RECALL', 'RECALL_TASK']));

    const org = await expectStatus(200, 'GET', `/organizations/${batch.origin.id}`, { token: farmer });
    expect(org.body.trustRating).toBeLessThan(67);

    await mock.api.reset();
    await expectStatus(404, 'GET', `/public/batches/${batch.publicCode}`);
  });
});
