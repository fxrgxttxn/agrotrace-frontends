<script lang="ts">
  import { BATCH_STATUSES } from '@agrotrace/domain';
  import { enumLabel, formatDecimal, formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
  import type { Schemas } from '@agrotrace/api-client';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import OrgPicker from '../../app/OrgPicker.svelte';
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
  import { viewerOf } from '../viewer';
  import { BATCHES_SPEC, producedOf, SEVERAL, SIZE, type BatchItem, type BatchStatus } from './batches';

  const viewer = $derived(viewerOf(session.me!));
  const list = listParams(() => '/batches', BATCHES_SPEC);
  const products = dictionary('products');
  const q = $derived(list.get('q'));
  const status = $derived(list.params.getAll('status'));
  const productId = $derived(list.get('productId'));
  const kind = $derived(list.get('kind'));
  const holder = $derived(viewer.participant ? list.get('holder') : '');
  const origin = $derived(viewer.participant ? list.get('origin') : '');
  const orgId = $derived(viewer.overseer ? list.get('orgId') : '');
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived(
    (status.length ? 1 : 0) + [productId, kind, holder, origin, orgId, from, to].filter(Boolean).length,
  );

  const batches = query(
    () => [
      'batches',
      list.page,
      list.params.get('sort'),
      q,
      status.join(','),
      productId,
      kind,
      holder,
      origin,
      orgId,
      from,
      to,
    ],
    ([, pageNo, sort, text, statuses, product, k, h, o, org, f, until]) =>
      call<Schemas['BatchPage']>(
        session.api.GET('/batches', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(statuses ? { status: String(statuses).split(',') as BatchStatus[] } : {}),
              ...(product ? { productId: String(product) } : {}),
              ...(k ? { kind: k as Schemas['BatchKind'] } : {}),
              ...(h ? { holder: h as 'me' | 'all' } : {}),
              ...(o ? { origin: o as 'me' | 'all' } : {}),
              ...(org ? { orgId: String(org) } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'batches.failed' },
  );
  const items = $derived(batches.data?.items ?? []);
  $effect(() => {
    const data = batches.data;
    if (data && data.items.length === 0 && data.total > 0) list.clampPage(data.total, SIZE);
  });
  const gap = $derived(batches.data ? listGap(batches.data, list.page, SIZE) : null);
  const producedSort = $derived(kind === 'DERIVED' ? 'producedAt' : kind === 'RAW' ? 'harvestedAt' : undefined);

  const columns: Column<BatchItem>[] = $derived([
    { key: 'code', header: t('batches.code'), primary: true, sortField: 'publicCode' },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'mass', header: t('batches.mass'), numeric: true, sortField: 'massKg' },
    { key: 'holder', header: t('batches.holder') },
    { key: 'produced', header: t('batches.producedOn'), sortField: producedSort },
    { key: 'updated', header: t('batches.updatedAt'), sortField: 'updatedAt' },
  ]);
  const sortOptions = $derived([
    { value: 'updatedAt,desc', label: t('batches.sort.updated') },
    { value: 'publicCode,asc', label: t('batches.sort.code') },
    { value: 'massKg,desc', label: t('batches.sort.massDesc') },
    { value: 'massKg,asc', label: t('batches.sort.massAsc') },
    ...(producedSort ? [{ value: `${producedSort},desc`, label: t('batches.sort.producedDesc') }] : []),
  ]);
</script>

{#snippet cell(b: BatchItem, c: Column<BatchItem>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{b.id}" code={b.publicCode} sub={b.product.name} />
  {:else if c.key === 'status'}
    <Chip status={b.status} />
  {:else if c.key === 'mass'}{formatDecimal(b.massKg, LOCALE)}{:else if c.key === 'holder'}{b.holder
      .name}{:else if c.key === 'produced'}{@const at = producedOf(b)}{at
      ? formatLocalDate(at, LOCALE)
      : '—'}{:else}{formatLocalDateTime(b.updatedAt, LOCALE)}{/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('batches.status')}>
    <Select
      value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ status: e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      {#if status.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: status.length })}</option>
      {/if}
      {#each BATCH_STATUSES as s (s)}
        <option value={s}>{enumLabel(t, 'BatchStatus', s)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-product" label={t('batches.product')}>
    <Select value={productId} onchange={(e) => list.set({ productId: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each products.data ?? [] as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-kind" label={t('batches.kind')}>
    <Select value={kind} onchange={(e) => list.set({ kind: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each ['RAW', 'DERIVED'] as k (k)}
        <option value={k}>{enumLabel(t, 'BatchKind', k)}</option>
      {/each}
    </Select>
  </Field>
  {#if viewer.participant}
    <Field id="filter-holder" label={t('batches.holder')}>
      <Select value={holder} onchange={(e) => list.set({ holder: e.currentTarget.value })}>
        <option value="">{enumLabel(t, 'param:holder', 'all')}</option>
        <option value="me">{enumLabel(t, 'param:holder', 'me')}</option>
      </Select>
    </Field>
    <Field id="filter-origin" label={t('batches.origin')}>
      <Select value={origin} onchange={(e) => list.set({ origin: e.currentTarget.value })}>
        <option value="">{enumLabel(t, 'param:origin', 'all')}</option>
        <option value="me">{enumLabel(t, 'param:origin', 'me')}</option>
      </Select>
    </Field>
  {/if}
  {#if viewer.overseer}
    <OrgPicker id="filter-org" label={t('batches.organization')} value={orgId} onchange={(id) => list.set({ orgId: id })} />
  {/if}
  <DateFilter
    id="filter-from"
    label={t('batches.from')}
    value={from}
    max={to || undefined}
    onchange={(v) => list.set({ from: v })}
  />
  <DateFilter id="filter-to" label={t('batches.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

{#snippet pageActions()}
  <Button variant="primary" icon="plus" href="/batches/new">{t('action.createBatch')}</Button>
{/snippet}
<Page actions={viewer.farmer ? pageActions : undefined} title={t('page.batches')}>
  <PageToolbar
    search={{
      label: t('batches.search'),
      placeholder: t('batches.searchPlaceholder'),
      value: q,
      onchange: (text) => list.set({ q: text }),
    }}
    {count}
    {filters}
  />
  {#if !batches.data && batches.failed}
    <AreaFailed
      text={t('batches.failed')}
      busy={batches.fetching}
      onretry={() => void userAction(batches.refetch)}
      onreset={isBadListQuery(batches.error) ? list.reset : undefined}
    />
  {:else if !batches.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={batches.fetching} onreload={() => void userAction(batches.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-batches" text={t('empty.batches')}>
          {#snippet action()}
            <Button variant="primary" href={viewer.farmer ? '/batches/new' : '/'}
              >{viewer.farmer ? t('action.createBatch') : t('action.home')}</Button
            >
          {/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={batches.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.batches')}
        {columns}
        rows={items}
        rowKey={(b) => b.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={batches.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
