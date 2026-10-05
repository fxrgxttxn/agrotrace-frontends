<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams, type ListSpec } from '../../app/listState.svelte';
  import { COMPLAINT_TONE } from '../../app/recalls';
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

  type Item = Schemas['ComplaintListItem'];
  type Status = Schemas['ComplaintStatus'];
  type Decision = Schemas['ComplaintDecisionType'];
  const SIZE = 20;
  const SEVERAL = '__several';
  const STATUSES: readonly Status[] = ['NEW', 'IN_REVIEW', 'DECIDED'];
  const DECISIONS: readonly Decision[] = ['REJECT', 'LAB_TEST', 'RECALL'];
  const SPEC: ListSpec = {
    sort: ['createdAt', 'decidedAt'],
    enums: { status: STATUSES, decision: DECISIONS },
    dates: ['from', 'to'],
    texts: ['q'],
  };
  const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

  const list = listParams(() => '/complaints', SPEC);
  const q = $derived(list.get('q'));
  const status = $derived(list.params.getAll('status'));
  const decision = $derived(list.params.getAll('decision'));
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived(
    (status.length ? 1 : 0) + (decision.length ? 1 : 0) + [from, to].filter(Boolean).length,
  );

  const complaints = query(
    () => ['complaints', list.page, list.params.get('sort'), q, status.join(','), decision.join(','), from, to],
    ([, pageNo, sort, text, statuses, decisions, f, until]) =>
      call<Schemas['ComplaintPage']>(
        session.api.GET('/complaints', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(statuses ? { status: String(statuses).split(',') as Status[] } : {}),
              ...(decisions ? { decision: String(decisions).split(',') as Decision[] } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'complaints.failed' },
  );
  const items = $derived(complaints.data?.items ?? []);
  const gap = $derived(complaints.data ? listGap(complaints.data, list.page, SIZE) : null);
  $effect(() => {
    const data = complaints.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const columns: Column<Item>[] = [
    { key: 'batch', header: t('complaints.batch'), primary: true },
    { key: 'status', header: t('complaints.status'), status: true },
    { key: 'text', header: t('complaints.text') },
    { key: 'decision', header: t('complaints.decision'), sortField: 'decidedAt' },
    { key: 'created', header: t('complaints.createdAt'), sortField: 'createdAt' },
  ];
  const sortOptions = [
    { value: 'createdAt,desc', label: t('complaints.sort.created') },
    { value: 'decidedAt,desc', label: t('complaints.sort.decided') },
  ];
</script>

{#snippet cell(x: Item, c: Column<Item>)}
  {#if c.key === 'batch'}
    <TablePrimary href="/complaints/{x.id}" code={x.batch.publicCode} sub={x.batch.product.name} />
  {:else if c.key === 'status'}
    <Chip tone={COMPLAINT_TONE[x.status]}>{enumLabel(t, 'ComplaintStatus', x.status)}</Chip>
  {:else if c.key === 'text'}
    {x.text}
  {:else if c.key === 'decision'}
    {#if x.decision}<span class="at-table__primary"
        ><span>{enumLabel(t, 'ComplaintDecisionType', x.decision)}</span>{#if x.decidedAt}<span class="at-table__sub"
            >{at(x.decidedAt)}</span
          >{/if}</span
      >{:else}—{/if}
  {:else}
    {at(x.createdAt)}
  {/if}
{/snippet}

{#snippet multi(key: 'status' | 'decision', values: string[], all: readonly string[], enumName: string)}
  <Select
    value={values.length === 1 ? values[0] : values.length > 1 ? SEVERAL : ''}
    onchange={(e) => list.set({ [key]: e.currentTarget.value })}
  >
    <option value="">{t('filters.any')}</option>
    {#if values.length > 1}
      <option value={SEVERAL} disabled>{t('filters.several', { count: values.length })}</option>
    {/if}
    {#each all as v (v)}
      <option value={v}>{enumLabel(t, enumName, v)}</option>
    {/each}
  </Select>
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('complaints.status')}>
    {@render multi('status', status, STATUSES, 'ComplaintStatus')}
  </Field>
  <Field id="filter-decision" label={t('complaints.decision')}>
    {@render multi('decision', decision, DECISIONS, 'ComplaintDecisionType')}
  </Field>
  <DateFilter id="filter-from" label={t('complaints.from')} value={from} max={to || undefined} onchange={(v) => list.set({ from: v })} />
  <DateFilter id="filter-to" label={t('complaints.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

<Page title={t('page.complaints')}>
  <PageToolbar
    search={{ label: t('complaints.search'), placeholder: t('complaints.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
    {count}
    {filters}
  />
  {#if !complaints.data && complaints.failed}
    <AreaFailed
      text={t('complaints.failed')}
      busy={complaints.fetching}
      onretry={() => void userAction(complaints.refetch)}
      onreset={isBadListQuery(complaints.error) ? list.reset : undefined}
    />
  {:else if !complaints.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={complaints.fetching} onreload={() => void userAction(complaints.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-complaints" text={t('empty.complaints')} />
      {/if}
    </Card>
  {:else}
    <div aria-busy={complaints.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.complaints')}
        {columns}
        rows={items}
        rowKey={(x) => x.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={complaints.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
