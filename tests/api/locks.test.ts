/**
 * Lock strengths (R52, P57; contract info.description «Сила блокировок»): rows an operation locks only to change
 * non-key columns are taken `FOR NO KEY UPDATE`, so the `FOR KEY SHARE` that PostgreSQL takes on a parent row for
 * every insert/update of a referencing row never waits for them — implicit key locks cannot close a cycle with the
 * explicit R52 order.
 *
 * The regression of the final review (I2): confirmRecallTask locks recall → batch → task; submitLabResults with FAIL
 * on a batch that already is the source of an OPEN recall locks test → batch and then writes `lab_tests.recall_id`
 * (KEY SHARE on that recall). With the recall taken `FOR UPDATE` the two deadlock (40P01). The interleaving is made
 * deterministic with a row lock held by the test (sanctioned fixture, P59): an indicator row `FOR UPDATE` stops the
 * submit at its `lab_results` insert (KEY SHARE on the indicator) while it holds the test and the batch; the confirm
 * then takes the recall and waits for the batch; the indicator is released. The submit must never wait for the
 * confirm (it would, for deadlock_timeout, before PostgreSQL aborts one of them).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { expectContract } from './lib/contract.js';
import { blockedBy, closeDb, holdRowLock } from './lib/db.js';
import { eventually } from './lib/production.js';
import {
  confirmTask,
  createRecall,
  freshFarm,
  inspector,
  inspectorTest,
  labApproved,
  vetlab,
} from './lib/quality.js';

afterAll(async () => {
  await closeDb();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('lock strengths (R52, P57)', () => {
  it('confirmRecallTask ∥ submitLabResults FAIL joining the OPEN recall of its batch: no deadlock, both 200', async () => {
    const farm = await freshFarm();
    const b = await labApproved(farm);
    const test = await inspectorTest(b.id);
    const rec = await createRecall(await inspector(), {
      sourceBatchId: b.id,
      reason: 'Регрессия порядка блокировок (P57)',
      blockUpstream: false,
    });
    expect(rec.status, rec.text).toBe(201);
    const task = (rec.body.tasks as { id: string; version: number; batch: { id: string } }[]).find(
      (t) => t.batch.id === b.id,
    )!;
    expect(task, 'the source batch has a task of its holder').toBeDefined();
    const lab = await vetlab();

    const hold = await holdRowLock('SELECT id FROM indicators WHERE id = $1 FOR UPDATE', [
      test.norms[0]!.indicatorId,
    ]);
    let released = false;
    try {
      const submit = lab.client.post(
        `/lab-tests/${test.id}/results`,
        { results: test.norms.map((n) => ({ indicatorId: n.indicatorId, value: '99999' })) },
        { headers: { 'If-Match': String(test.version) } },
      );
      // The submit holds the test and the batch and waits for the indicator (its lab_results insert).
      const submitPid = await eventually(async () => (await blockedBy(hold.pid))[0], 15000, 20);
      const confirm = confirmTask(farm.client, task.id, task.version);
      // The confirm holds the recall and waits for the batch.
      const confirmPid = await eventually(async () => (await blockedBy(submitPid))[0], 15000, 20);

      let submitWaitedForConfirm = false;
      let settled = false;
      const watch = (async () => {
        while (!settled) {
          if ((await blockedBy(confirmPid)).includes(submitPid)) submitWaitedForConfirm = true;
          await sleep(5);
        }
      })();
      await hold.release();
      released = true;
      const [s, c] = await Promise.all([submit, confirm]);
      settled = true;
      await watch;

      await expectContract(s, 'submitLabResults');
      expect(s.status, s.text).toBe(200);
      expect(s.body).toMatchObject({ conclusion: 'FAIL', recallId: rec.body.id });
      expect(c.status, c.text).toBe(200);
      expect(c.body.status).toBe('CONFIRMED');
      expect(
        submitWaitedForConfirm,
        'the submit waited for the confirm (KEY SHARE on the recall against FOR UPDATE)',
      ).toBe(false);
    } finally {
      if (!released) await hold.release();
    }
  });
});
