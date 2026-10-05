<script lang="ts">
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatMass } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import CodeConfirmDialog from '../../app/CodeConfirmDialog.svelte';
  import { DialogAlert, FormAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { Idempotency } from '../../app/idempotency';
  import { ALL, collapseAll, isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import { clock } from '../../app/now.svelte';
  import { taskConfirmable } from '../../app/recalls';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Field from '../../ui/Field.svelte';
  import ListChanged from '../../ui/ListChanged.svelte';
  import Page from '../../ui/Page.svelte';
  import PageToolbar from '../../ui/PageToolbar.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Select from '../../ui/Select.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import { ACTIVE, SEVERAL, SIZE, STACK, TASK_STATUSES, TASKS_SPEC, TICK_MS, type Task, type TaskStatus } from './recalls';
  import TaskChip from './TaskChip.svelte';
  import TaskConfirmed from './TaskConfirmed.svelte';
  import TaskDue from './TaskDue.svelte';

  const screen = screenScope();
  const alert = new FormAlert();
  const idempotent = new Idempotency();
  const now = clock(TICK_MS);
  const list = listParams(() => '/recall-tasks', TASKS_SPEC);
  collapseAll(() => '/recall-tasks');
  const q = $derived(list.get('q'));
  const statusParam = $derived(list.params.getAll('status'));
  const status = $derived(statusParam.includes(ALL) ? [ALL] : statusParam);
  const overdue = $derived(list.get('overdue'));
  const count = $derived((status.length ? 1 : 0) + (overdue ? 1 : 0));
  const allOnly = $derived(status[0] === ALL && !q && count === 1);

  const tasks = query(
    () => ['recallTasks', list.page, list.params.get('sort'), q, status.join(','), overdue],
    ([, pageNo, sort, text, statuses, late]) => {
      const chosen = String(statuses ?? '');
      const sent: readonly TaskStatus[] = chosen === ALL ? [] : chosen ? (chosen.split(',') as TaskStatus[]) : ACTIVE;
      return call<Schemas['RecallTaskPage']>(
        session.api.GET('/recall-tasks', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(sent.length ? { status: [...sent] } : {}),
              ...(late ? { overdue: late === 'true' } : {}),
            },
          },
        }),
      );
    },
    { failed: 'recallTasks.failed' },
  );
  const items = $derived(tasks.data?.items ?? []);
  const gap = $derived(tasks.data ? listGap(tasks.data, list.page, SIZE) : null);
  $effect(() => {
    const data = tasks.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  let target = $state<string | null>(null);
  let busy = $state(false);
  const wait = new Countdown();
  $effect(() => () => wait.stop());
  const failure = new DialogAlert();
  const shown = $derived(items.find((x) => x.id === target) ?? null);
  const stale = $derived(target !== null && tasks.data !== null && (!shown || !taskConfirmable(shown.status)));
  $effect(() => {
    if (!stale) return;
    target = null;
    failure.clear();
  });
  function close() {
    failure.handOff();
    target = null;
  }

  const reread = () => void cache.invalidate(['recallTasks']);
  async function confirm(task: Task) {
    busy = true;
    failure.clear();
    alert.clear();
    try {
      await idempotent.run(
        { id: task.id, version: task.version },
        (key) =>
          call<Task>(
            session.api.POST('/recall-tasks/{id}/confirm', {
              params: { path: { id: task.id }, header: { 'If-Match': task.version, 'Idempotency-Key': key } },
              body: {},
            }),
          ),
        task.id,
      );
      if (screen.alive()) close();
      reread();
      for (const key of ['batches', 'batch', 'dashboard', 'notifications']) void cache.invalidate([key]);
      screen.done({ tone: 'ok', text: t('recallTasks.confirmed', { code: task.batch.publicCode }) });
    } catch (e) {
      if (!screen.alive()) return;
      const code = task.batch.publicCode;
      let text: string;
      let closing = false;
      if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
        reread();
        text = t('recallTasks.versionConflict');
      } else if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        reread();
        closing = true;
        text = t('recallTasks.alreadyConfirmed', { code });
      } else if (e instanceof ApiProblem && e.status === 404) {
        reread();
        closing = true;
        text = t('recallTasks.gone');
      } else {
        if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
        text = errorText(e);
      }
      if (closing) {
        target = null;
        alert.show(text, errorTone(e));
      } else failure.show(text, errorTone(e));
    } finally {
      busy = false;
    }
  }

  const columns: Column<Task>[] = [
    { key: 'batch', header: t('recallTasks.batch'), primary: true },
    { key: 'status', header: t('recallTasks.status'), status: true },
    { key: 'reason', header: t('recallTasks.reason') },
    { key: 'due', header: t('recallTasks.dueAt'), sortField: 'dueAt' },
    { key: 'confirmed', header: t('recallTasks.confirmedAt'), sortField: 'confirmedAt' },
  ];
  const sortOptions = [
    { value: 'dueAt,asc', label: t('recallTasks.sort.due') },
    { value: 'createdAt,desc', label: t('recallTasks.sort.created') },
    { value: 'confirmedAt,desc', label: t('recallTasks.sort.confirmed') },
  ];
</script>

{#snippet cell(x: Task, c: Column<Task>)}
  {#if c.key === 'batch'}
    <TablePrimary href="/batches/{x.batch.id}" code={x.batch.publicCode} sub={x.batch.product.name} />
  {:else if c.key === 'status'}
    <TaskChip task={x} now={now.now} />
  {:else if c.key === 'reason'}
    {x.recallReason}
  {:else if c.key === 'due'}
    <TaskDue task={x} now={now.now} />
  {:else}
    <TaskConfirmed task={x} />
  {/if}
{/snippet}

{#snippet rowActions(x: Task)}
  {#if taskConfirmable(x.status)}
    <Button
      variant="danger"
      icon="check"
      aria-label={t('recallTasks.confirmFor', { code: x.batch.publicCode })}
      onclick={() => {
        failure.clear();
        target = x.id;
      }}
    >
      {t('action.confirmSeizure')}
    </Button>
  {/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('recallTasks.status')}>
    <Select
      value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ status: e.currentTarget.value })}
    >
      <option value="">{t('recallTasks.active')}</option>
      <option value={ALL}>{t('filters.any')}</option>
      {#if status.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: status.length })}</option>
      {/if}
      {#each TASK_STATUSES as v (v)}
        <option value={v}>{enumLabel(t, 'RecallTaskStatus', v)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-overdue" label={t('recallTasks.overdueFilter')}>
    <Select value={overdue} onchange={(e) => list.set({ overdue: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      <option value="true">{t('recallTasks.overdueOnly')}</option>
      <option value="false">{t('recallTasks.overdueNone')}</option>
    </Select>
  </Field>
{/snippet}

{#snippet confirmText()}
  {#if shown}
    <p style="margin: 0">
      {t('recallTasks.confirmText', { product: shown.batch.product.name, mass: formatMass(shown.batch.massKg, LOCALE) })}
    </p>
  {/if}
{/snippet}

<Page title={t('page.recallTasks')}>
  <PageToolbar
    search={{
      label: t('recallTasks.search'),
      placeholder: t('recallTasks.searchPlaceholder'),
      value: q,
      onchange: (text) => list.set({ q: text }),
    }}
    {count}
    {filters}
  />
  {#if !tasks.data && tasks.failed}
    <AreaFailed
      text={t('recallTasks.failed')}
      busy={tasks.fetching}
      onretry={() => void userAction(tasks.refetch)}
      onreset={isBadListQuery(tasks.error) ? list.reset : undefined}
    />
  {:else if !tasks.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={tasks.fetching} onreload={() => void userAction(tasks.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if allOnly}
        <Empty art="empty-recalls" text={t('recallTasks.empty')} />
      {:else if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-recalls" text={t('recallTasks.empty')}>
          {#snippet action()}<Button variant="primary" onclick={() => list.set({ status: ALL })}
              >{t('recallTasks.showAll')}</Button
            >{/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={tasks.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={t('page.recallTasks')}
        {columns}
        rows={items}
        rowKey={(x) => x.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
        actions={rowActions}
      />
      <Pagination page={list.page} size={SIZE} total={tasks.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
  <CodeConfirmDialog
    open={shown !== null}
    title={shown ? t('recallTasks.confirmTitle', { code: shown.batch.publicCode }) : ''}
    text={confirmText}
    code={shown?.batch.publicCode ?? ''}
    confirmLabel={enumLabel(t, 'BatchActionName', 'writeOff')}
    {busy}
    wait={wait.left}
    message={failure.message}
    onclose={close}
    onconfirm={() => {
      const task = shown;
      if (task) void userAction(() => confirm(task));
    }}
  />
</Page>
