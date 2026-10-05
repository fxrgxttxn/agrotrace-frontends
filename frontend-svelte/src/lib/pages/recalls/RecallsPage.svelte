<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import { RECALL_TONE } from '../../app/recalls';
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
  import RecallProgress from './RecallProgress.svelte';
  import { at, RECALLS_SPEC, SEVERAL, SIZE, STACK, TRIGGERS, type RecallItem } from './recalls';

  const list = listParams(() => '/recalls', RECALLS_SPEC);
  const q = $derived(list.get('q'));
  const status = $derived(list.get('status'));
  const trigger = $derived(list.params.getAll('trigger'));
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived((trigger.length ? 1 : 0) + [status, from, to].filter(Boolean).length);

  const recalls = query(
    () => ['recalls', list.page, list.params.get('sort'), q, status, trigger.join(','), from, to],
    ([, pageNo, sort, text, st, triggers, f, until]) =>
      call<Schemas['RecallPage']>(
        session.api.GET('/recalls', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(st ? { status: st as Schemas['RecallStatus'] } : {}),
              ...(triggers ? { trigger: String(triggers).split(',') as Schemas['RecallTrigger'][] } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'recalls.failed' },
  );
  const items = $derived(recalls.data?.items ?? []);
  const gap = $derived(recalls.data ? listGap(recalls.data, list.page, SIZE) : null);
  $effect(() => {
    const data = recalls.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const columns: Column<RecallItem>[] = [
    { key: 'source', header: t('recalls.source'), primary: true },
    { key: 'status', header: t('recalls.status'), status: true },
    { key: 'trigger', header: t('recalls.trigger') },
    { key: 'progress', header: t('recalls.progress') },
    { key: 'batches', header: t('recalls.batchesCount'), numeric: true },
    { key: 'opened', header: t('recalls.openedAt'), sortField: 'openedAt' },
    { key: 'closed', header: t('recalls.closedAt'), sortField: 'closedAt' },
  ];
  const sortOptions = [
    { value: 'openedAt,desc', label: t('recalls.sort.opened') },
    { value: 'closedAt,desc', label: t('recalls.sort.closed') },
  ];
</script>

{#snippet cell(x: RecallItem, c: Column<RecallItem>)}
  {#if c.key === 'source'}
    <TablePrimary href="/recalls/{x.id}" code={x.sourceBatch.publicCode} sub={x.sourceBatch.product.name} />
  {:else if c.key === 'status'}
    <Chip tone={RECALL_TONE[x.status]}>{enumLabel(t, 'RecallStatus', x.status)}</Chip>
  {:else if c.key === 'trigger'}
    <span class="at-table__primary"
      ><span>{enumLabel(t, 'RecallTrigger', x.trigger)}</span><span class="at-table__sub">{x.reason}</span></span
    >
  {:else if c.key === 'progress'}
    <RecallProgress id="progress-{x.id}" progress={x.progress} inTable />
  {:else if c.key === 'batches'}
    {x.batchesCount}
  {:else if c.key === 'opened'}
    {at(x.openedAt)}
  {:else}
    {x.closedAt ? at(x.closedAt) : '—'}
  {/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('recalls.status')}>
    <Select value={status} onchange={(e) => list.set({ status: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      <option value="OPEN">{enumLabel(t, 'RecallStatus', 'OPEN')}</option>
      <option value="CLOSED">{enumLabel(t, 'RecallStatus', 'CLOSED')}</option>
    </Select>
  </Field>
  <Field id="filter-trigger" label={t('recalls.trigger')}>
    <Select
      value={trigger.length === 1 ? trigger[0] : trigger.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ trigger: e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      {#if trigger.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: trigger.length })}</option>
      {/if}
      {#each TRIGGERS as v (v)}
        <option value={v}>{enumLabel(t, 'RecallTrigger', v)}</option>
      {/each}
    </Select>
  </Field>
  <DateFilter id="filter-from" label={t('recalls.from')} value={from} max={to || undefined} onchange={(v) => list.set({ from: v })} />
  <DateFilter id="filter-to" label={t('recalls.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

<Page title={t('page.recalls')}>
  {#snippet actions()}
    <Button variant="danger" href="/recalls/new">{t('action.startRecall')}</Button>
  {/snippet}
  <PageToolbar
    search={{ label: t('recalls.search'), placeholder: t('recalls.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
    {count}
    {filters}
  />
  {#if !recalls.data && recalls.failed}
    <AreaFailed
      text={t('recalls.failed')}
      busy={recalls.fetching}
      onretry={() => void userAction(recalls.refetch)}
      onreset={isBadListQuery(recalls.error) ? list.reset : undefined}
    />
  {:else if !recalls.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={recalls.fetching} onreload={() => void userAction(recalls.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-recalls" text={t('empty.recalls')} />
      {/if}
    </Card>
  {:else}
    <div aria-busy={recalls.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={t('page.recalls')}
        {columns}
        rows={items}
        rowKey={(x) => x.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={recalls.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
