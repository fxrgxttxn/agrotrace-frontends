<script lang="ts">
  import { availableActions } from '@agrotrace/domain';
  import { enumLabel, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
  import { ApiProblem } from '@agrotrace/api-client';
  import { call, errorText, errorTone } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery } from '../../app/listState.svelte';
  import { screenScope } from '../../app/screen';
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
  import { ownBatches, SEVERAL, SIZE, stockStatuses, STOCK_SPEC, type Batch, type BatchItem } from './stock.svelte';

  const me = session.me!;
  const processor = me.roles.some((r) => r === 'PROCESSOR');
  const retailer = me.roles.some((r) => r === 'RETAILER');
  const statuses = stockStatuses(processor, retailer);
  const own = ownBatches('/stock', statuses, STOCK_SPEC, 'stock.failed');
  const products = dictionary('products');
  const screen = screenScope();
  let busyId = $state<string | null>(null);

  function reread() {
    void cache.invalidate(['batches']);
    void cache.invalidate(['batch']);
  }

  async function transition(row: BatchItem, action: 'putOnSale' | 'sell') {
    busyId = row.id;
    const code = row.publicCode;
    try {
      const batch = await call<Batch>(session.api.GET('/batches/{id}', { params: { path: { id: row.id } } }));
      if (!batch.actions.some((a) => a.action === action)) {
        reread();
        screen.push({ tone: 'danger', text: t('stock.unavailable', { code }) });
        return;
      }
      const params = { path: { id: row.id }, header: { 'If-Match': batch.version } };
      const next = await call<Batch>(
        action === 'putOnSale'
          ? session.api.POST('/batches/{id}/on-sale', { params })
          : session.api.POST('/batches/{id}/sold', { params }),
      );
      cache.set(['batch', next.id], next, cache.generation);
      reread();
      screen.done({ tone: 'ok', text: t(action === 'putOnSale' ? 'stock.putOnSale' : 'stock.sold', { code }) });
    } catch (e) {
      if (e instanceof ApiProblem && (e.code === 'VERSION_CONFLICT' || e.code === 'INVALID_TRANSITION')) {
        reread();
        screen.push({ tone: 'danger', text: t('stock.changed', { code }) });
      } else {
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 403)) reread();
        screen.push({ tone: errorTone(e), text: errorText(e) });
      }
    } finally {
      busyId = null;
    }
  }

  const columns: Column<BatchItem>[] = [
    { key: 'code', header: t('batches.code'), primary: true, sortField: 'publicCode' },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'mass', header: t('batches.mass'), numeric: true, sortField: 'massKg' },
    { key: 'origin', header: t('batches.origin') },
    { key: 'updated', header: t('batches.updatedAt'), sortField: 'updatedAt' },
  ];
  const sortOptions = [
    { value: 'updatedAt,desc', label: t('batches.sort.updated') },
    { value: 'publicCode,asc', label: t('batches.sort.code') },
    { value: 'massKg,desc', label: t('batches.sort.massDesc') },
    { value: 'massKg,asc', label: t('batches.sort.massAsc') },
  ];
</script>

{#snippet cell(b: BatchItem, c: Column<BatchItem>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{b.id}" code={b.publicCode} sub={b.product.name} />
  {:else if c.key === 'status'}
    <Chip status={b.status} />
  {:else if c.key === 'mass'}{formatDecimal(b.massKg, LOCALE)}{:else if c.key === 'origin'}{b.origin
      .name}{:else}{formatLocalDateTime(b.updatedAt, LOCALE)}{/if}
{/snippet}

{#snippet rowActions(b: BatchItem)}
  {@const allowed = new Set(availableActions(b.status).map((a) => a.action))}
  {#if processor && allowed.has('process')}
    <Button size="s" variant="primary" href="/processing/new?batchId={b.id}">{enumLabel(t, 'BatchActionName', 'process')}</Button>
  {/if}
  {#if processor && allowed.has('ship')}
    <Button size="s" href="/waybills/new?batchId={b.id}">{enumLabel(t, 'BatchActionName', 'ship')}</Button>
  {/if}
  {#if retailer}
    {#each ['putOnSale', 'sell'] as const as a (a)}
      {#if allowed.has(a)}
        <Button
          size="s"
          variant={a === 'putOnSale' ? 'primary' : 'secondary'}
          busy={busyId === b.id}
          onclick={() => void userAction(() => transition(b, a))}
        >
          {enumLabel(t, 'BatchActionName', a)}
        </Button>
      {/if}
    {/each}
  {/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('batches.status')}>
    <Select
      value={own.chosen.length === 1 ? own.chosen[0] : own.chosen.length > 1 ? SEVERAL : ''}
      onchange={(e) => own.list.set({ status: e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      {#if own.chosen.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: own.chosen.length })}</option>
      {/if}
      {#each statuses as s (s)}
        <option value={s}>{enumLabel(t, 'BatchStatus', s)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-product" label={t('batches.product')}>
    <Select value={own.productId} onchange={(e) => own.list.set({ productId: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each products.data ?? [] as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
    </Select>
  </Field>
{/snippet}

<Page title={t('page.stock')}>
  {#snippet actions()}
    {#if processor}
      <Button variant="primary" icon="factory" href="/processing/new">{t('processing.submit')}</Button>
    {/if}
  {/snippet}
  <PageToolbar
    search={{ label: t('stock.search'), placeholder: t('stock.searchPlaceholder'), value: own.q, onchange: (text) => own.list.set({ q: text }) }}
    count={own.count}
    {filters}
  />
  {#if !own.batches.data && own.batches.failed}
    <AreaFailed
      text={t('stock.failed')}
      busy={own.batches.fetching}
      onretry={() => void userAction(own.batches.refetch)}
      onreset={isBadListQuery(own.batches.error) ? own.list.reset : undefined}
    />
  {:else if !own.batches.data || own.gap === 'pastEnd'}
    <AreaLoading />
  {:else if own.gap === 'changed'}
    <ListChanged busy={own.batches.fetching} onreload={() => void userAction(own.batches.refetch)} />
  {:else if own.batches.data.items.length === 0}
    <Card>
      {#if own.q || own.count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={own.list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-batches" text={t('stock.empty')}>
          {#snippet action()}<Button variant="primary" href="/waybills?direction=incoming">{t('waybillDirection.incoming')}</Button>{/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={own.batches.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.stock')}
        {columns}
        rows={own.batches.data.items}
        rowKey={(b) => b.id}
        sort={own.list.sort}
        onsort={own.list.setSort}
        {sortOptions}
        actions={rowActions}
        {cell}
      />
      <Pagination page={own.list.page} size={SIZE} total={own.batches.data.total} hrefFor={own.list.hrefFor} />
    </div>
  {/if}
</Page>
