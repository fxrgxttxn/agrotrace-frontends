import { canEntityTransition } from './transitions.js';
import type { Store } from '../store/store.js';
import { notify } from './notify.js';

export function runSchedulers(store: Store): void {
  const now = store.now();
  const dueTests = store.t.lab_tests.filter(
    (t) => canEntityTransition('labTest', t.status, 'ESCALATED', 'system') && t.deleted_at === null && now > Date.parse(t.due_at),
  );
  for (const t of dueTests)
    store.run('system.labTestEscalate', null, () => {
      store.touch('labTest', t);
      store.patch(t, { status: 'ESCALATED', escalated_at: store.nowIso(), version: t.version + 1, updated_at: store.nowIso() });
      const b = store.must('batches', t.batch_id);
      const lab = store.must('organizations', t.lab_org_id);
      notify(store, 'LAB_OVERDUE', { orgHeads: [lab.id], roles: ['INSPECTOR'] }, {
        labTestId: t.id,
        batchId: b.id,
        publicCode: b.public_code,
        labOrgId: lab.id,
        labName: lab.name,
        dueAt: t.due_at,
      });
    });
  const dueTasks = store.t.recall_tasks.filter((t) => canEntityTransition('recallTask', t.status, 'OVERDUE', 'system') && now > Date.parse(t.due_at));
  for (const task of dueTasks)
    store.run('system.recallTaskOverdue', null, () => {
      store.touch('recallTask', task);
      store.patch(task, { status: 'OVERDUE', escalated_at: store.nowIso(), version: task.version + 1, updated_at: store.nowIso() });
      const b = store.must('batches', task.batch_id);
      const holder = store.must('organizations', task.holder_org_id);
      notify(store, 'OVERDUE', { orgs: [holder.id], roles: ['INSPECTOR'] }, {
        recallId: task.recall_id,
        taskId: task.id,
        batchId: b.id,
        publicCode: b.public_code,
        dueAt: task.due_at,
        holderOrgId: holder.id,
        holderName: holder.name,
      });
    });
}
