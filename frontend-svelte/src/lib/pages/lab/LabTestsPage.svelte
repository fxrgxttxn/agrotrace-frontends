<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { CONCLUSION_TONE, LAB_STATUS_TONE } from '../../app/labTests';
  import { ALL, collapseAll, isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Chip from '../../ui/Chip.svelte';
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
  import {
    ACTIVE,
    at,
    REASONS,
    SEVERAL,
    SIZE,
    SPEC,
    STACK,
    STATUSES,
    type Conclusion,
    type LabListItem,
    type LabReason,
    type LabStatus,
  } from './lab';

  const list = listParams(() => '/lab/tests', SPEC);
  collapseAll(() => '/lab/tests');
  const q = $derived(list.get('q'));
  const statusParam = $derived(list.params.getAll('status'));
  const status = $derived(statusParam.includes(ALL) ? [ALL] : statusParam);
  const reason = $derived(list.params.getAll('reason'));
  const conclusion = $derived(list.get('conclusion'));
  const overdue = $derived(list.get('overdue'));
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived(
    (status.length ? 1 : 0) + (reason.length ? 1 : 0) + [conclusion, overdue, from, to].filter(Boolean).length,
  );
  const allOnly = $derived(status[0] === ALL && !q && count === 1);

  const tests = query(
    () => [
      'labTests',
      list.page,
      list.params.get('sort'),
      q,
      status.join(','),
      reason.join(','),
      conclusion,
      overdue,
      from,
      to,
    ],
    ([, pageNo, sort, text, statuses, reasons, concl, late, f, until]) => {
      const chosen = String(statuses ?? '');
      const sent: readonly LabStatus[] = chosen === ALL ? [] : chosen ? (chosen.split(',') as LabStatus[]) : ACTIVE;
      return call<Schemas['LabTestPage']>(
        session.api.GET('/lab-tests', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(sent.length ? { status: [...sent] } : {}),
              ...(reasons ? { reason: String(reasons).split(',') as LabReason[] } : {}),
              ...(concl ? { conclusion: concl as Conclusion } : {}),
              ...(late ? { overdue: late === 'true' } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      );
    },
    { failed: 'lab.failed' },
  );
  const items = $derived(tests.data?.items ?? []);
  const gap = $derived(tests.data ? listGap(tests.data, list.page, SIZE) : null);
  $effect(() => {
    const data = tests.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const columns: Column<LabListItem>[] = [
    { key: 'batch', header: t('lab.batch'), primary: true },
    { key: 'status', header: t('labTests.status'), status: true },
    { key: 'reason', header: t('labTests.reason') },
    { key: 'due', header: t('labTests.dueAt'), sortField: 'dueAt' },
    { key: 'created', header: t('lab.createdAt'), sortField: 'createdAt' },
    { key: 'conclusion', header: t('labTests.conclusion'), sortField: 'completedAt' },
  ];
  const sortOptions = [
    { value: 'dueAt,asc', label: t('lab.sort.due') },
    { value: 'createdAt,desc', label: t('lab.sort.created') },
    { value: 'completedAt,desc', label: t('lab.sort.completed') },
  ];
</script>

{#snippet cell(x: LabListItem, c: Column<LabListItem>)}
  {#if c.key === 'batch'}
    <TablePrimary href="/lab/tests/{x.id}" code={x.batch.publicCode} sub={x.batch.product.name} />
  {:else if c.key === 'status'}
    <Chip tone={LAB_STATUS_TONE[x.status]}>{enumLabel(t, 'LabTestStatus', x.status)}</Chip>
  {:else if c.key === 'reason'}
    {enumLabel(t, 'LabTestReason', x.reason)}
  {:else if c.key === 'due'}
    <!-- eslint-disable-next-line svelte/no-useless-mustaches -->
    {at(x.dueAt)}{#if x.overdue}{' '}<Chip tone="danger">{t('labTests.overdue')}</Chip>{/if}
  {:else if c.key === 'created'}
    {at(x.createdAt)}
  {:else if x.conclusion}
    <span class="at-table__primary"
      ><Chip tone={CONCLUSION_TONE[x.conclusion]}>{enumLabel(t, 'LabConclusion', x.conclusion)}</Chip
      >{#if x.completedAt}<span class="at-table__sub">{at(x.completedAt)}</span>{/if}</span
    >
  {:else}
    —
  {/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('labTests.status')}>
    <Select
      value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ status: e.currentTarget.value })}
    >
      <option value="">{t('lab.active')}</option>
      <option value={ALL}>{t('filters.any')}</option>
      {#if status.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: status.length })}</option>
      {/if}
      {#each STATUSES as v (v)}
        <option value={v}>{enumLabel(t, 'LabTestStatus', v)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-reason" label={t('labTests.reason')}>
    <Select
      value={reason.length === 1 ? reason[0] : reason.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ reason: e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      {#if reason.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: reason.length })}</option>
      {/if}
      {#each REASONS as v (v)}
        <option value={v}>{enumLabel(t, 'LabTestReason', v)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-conclusion" label={t('labTests.conclusion')}>
    <Select value={conclusion} onchange={(e) => list.set({ conclusion: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      <option value="PASS">{enumLabel(t, 'LabConclusion', 'PASS')}</option>
      <option value="FAIL">{enumLabel(t, 'LabConclusion', 'FAIL')}</option>
    </Select>
  </Field>
  <Field id="filter-overdue" label={t('lab.overdueFilter')}>
    <Select value={overdue} onchange={(e) => list.set({ overdue: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      <option value="true">{t('lab.overdueOnly')}</option>
      <option value="false">{t('lab.overdueNone')}</option>
    </Select>
  </Field>
  <DateFilter id="filter-from" label={t('lab.from')} value={from} max={to || undefined} onchange={(v) => list.set({ from: v })} />
  <DateFilter id="filter-to" label={t('lab.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

<Page title={t('page.labTests')}>
  <PageToolbar
    search={{ label: t('lab.search'), placeholder: t('lab.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
    {count}
    {filters}
  />
  {#if !tests.data && tests.failed}
    <AreaFailed
      text={t('lab.failed')}
      busy={tests.fetching}
      onretry={() => void userAction(tests.refetch)}
      onreset={isBadListQuery(tests.error) ? list.reset : undefined}
    />
  {:else if !tests.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={tests.fetching} onreload={() => void userAction(tests.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if allOnly}
        <Empty art="empty-lab" text={t('lab.empty')} />
      {:else if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-lab" text={t('lab.empty')}>
          {#snippet action()}<Button variant="primary" onclick={() => list.set({ status: ALL })}>{t('lab.showAll')}</Button
            >{/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={tests.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={t('page.labTests')}
        {columns}
        rows={items}
        rowKey={(x) => x.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={tests.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
