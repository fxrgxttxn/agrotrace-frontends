<script lang="ts">
  import { untrack } from 'svelte';
  import { withVariant, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatDecimal } from '@agrotrace/i18n';
  import type { DictName } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Field from '../../ui/Field.svelte';
  import ListChanged from '../../ui/ListChanged.svelte';
  import PageToolbar from '../../ui/PageToolbar.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Select from '../../ui/Select.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import DeleteEntryDialog from './DeleteEntryDialog.svelte';
  import EntryDialog from './EntryDialog.svelte';
  import PhotoDialog from './PhotoDialog.svelte';
  import {
    CATEGORIES,
    entryName,
    SIZE,
    SOFT,
    SPECS,
    STACK,
    SUBSTANCE_TYPES,
    type Entry,
    type Indicator,
    type Norm,
    type Product,
    type Region,
    type Substance,
  } from './dictionaries';

  let { name }: { name: DictName } = $props();

  const dict = untrack(() => name);
  const list = listParams(() => `/admin/dictionaries/${dict}`, SPECS[dict]);
  const q = $derived(list.get('q'));
  const category = $derived(list.get('category'));
  const type = $derived(list.get('type'));
  const deleted = $derived(list.get('includeDeleted') === 'true');
  const count = $derived([category, type, deleted ? 'yes' : ''].filter(Boolean).length);
  let editing = $state<Entry | null>(null);
  let removing = $state<Entry | null>(null);
  let photo = $state<Product | null>(null);

  const rows = query(
    () => ['dictionaryAdmin', dict, list.page, list.params.get('sort'), q, category, type, deleted],
    ([, n, pageNo, sort, text, cat, ty, del]) =>
      call<Schemas['DictionaryPage']>(
        session.api.GET('/dictionaries/{name}', {
          params: {
            path: { name: n as DictName },
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(cat ? { category: cat as Schemas['ProductCategory'] } : {}),
              ...(ty ? { type: ty as Schemas['SubstanceType'] } : {}),
              ...(del ? { includeDeleted: true } : {}),
            },
          },
        }),
      ),
    { failed: 'dict.failed' },
  );
  const items = $derived((rows.data?.items ?? []) as Entry[]);
  const gap = $derived(rows.data ? listGap(rows.data, list.page, SIZE) : null);
  $effect(() => {
    const data = rows.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const isDeleted = (e: Entry) => 'deletedAt' in e && e.deletedAt !== null;
  const nameCol: Column<Entry> = { key: 'name', header: t('field.name'), primary: true, sortField: 'name' };
  const columns = $derived.by((): Column<Entry>[] => {
    const status: Column<Entry>[] =
      deleted && SOFT.includes(dict) ? [{ key: 'deleted', header: t('dict.state'), status: true }] : [];
    switch (dict) {
      case 'products':
        return [
          { key: 'photo', header: t('dict.photo') },
          nameCol,
          ...status,
          { key: 'category', header: t('field.category') },
          { key: 'loss', header: t('field.lossNormPercent'), numeric: true },
          { key: 'mercury', header: t('field.mercuryCode') },
        ];
      case 'substances':
        return [
          nameCol,
          ...status,
          { key: 'type', header: t('field.type') },
          { key: 'days', header: t('field.waitingPeriodDays'), numeric: true },
        ];
      case 'indicators':
        return [nameCol, ...status, { key: 'unit', header: t('field.unit') }];
      case 'norms':
        return [
          { key: 'product', header: t('field.productId'), primary: true, sortField: 'name' },
          { key: 'indicator', header: t('field.indicatorId') },
          { key: 'max', header: t('field.maxValue'), numeric: true },
        ];
      case 'regions':
        return [{ key: 'code', header: t('field.code') }, nameCol];
    }
  });
  const sortOptions = [
    { value: 'name,asc', label: t('dict.sort.nameAsc') },
    { value: 'name,desc', label: t('dict.sort.nameDesc') },
  ];
</script>

{#snippet cell(e: Entry, c: Column<Entry>)}
  {#if c.key === 'photo'}
    {@const p = e as Product}
    <Avatar name={p.name} src={p.imageUrl ? withVariant(p.imageUrl, 96) : null} size="s" shape="square" decorative />
  {:else if c.key === 'name'}
    <span class="at-table__primary"><span>{(e as { name: string }).name}</span></span>
  {:else if c.key === 'deleted'}
    {#if (e as { deletedAt: string | null }).deletedAt}<Chip tone="neutral">{t('dict.deleted')}</Chip>{:else}<Chip tone="ok"
        >{t('dict.inUse')}</Chip
      >{/if}
  {:else if c.key === 'category'}
    {enumLabel(t, 'ProductCategory', (e as Product).category)}
  {:else if c.key === 'loss'}
    {formatDecimal((e as Product).lossNormPercent, LOCALE)}
  {:else if c.key === 'mercury'}
    <span class="at-mono">{(e as Product).mercuryCode ?? '—'}</span>
  {:else if c.key === 'type'}
    {enumLabel(t, 'SubstanceType', (e as Substance).type)}
  {:else if c.key === 'days'}
    {(e as Substance).waitingPeriodDays}
  {:else if c.key === 'unit'}
    {(e as Indicator).unit}
  {:else if c.key === 'product'}
    <span class="at-table__primary"
      ><span>{(e as Norm).product.name}</span><span class="at-table__sub">{(e as Norm).indicator.name}</span></span
    >
  {:else if c.key === 'indicator'}
    {(e as Norm).indicator.name}
  {:else if c.key === 'max'}
    {`${formatDecimal((e as Norm).maxValue, LOCALE)} ${(e as Norm).indicator.unit}`}
  {:else if c.key === 'code'}
    <span class="at-mono">{(e as Region).code}</span>
  {/if}
{/snippet}

{#snippet rowActions(e: Entry)}
  {#if !isDeleted(e)}
    <Button size="s" aria-label={t('dict.editOf', { name: entryName(dict, e) })} onclick={() => (editing = e)}>
      {t('dict.edit')}
    </Button
    >{#if dict === 'products'}<Button
        size="s"
        icon="image"
        iconOnly
        aria-label={t('dict.photoOf', { name: entryName(dict, e) })}
        onclick={() => (photo = e as Product)}
      />{/if}<Button
      size="s"
      variant="ghost"
      icon="trash"
      iconOnly
      aria-label={t('dict.deleteOf', { name: entryName(dict, e) })}
      onclick={() => (removing = e)}
    />
  {/if}
{/snippet}

{#snippet filters()}
  {#if dict === 'products'}
    <Field id="filter-category" label={t('field.category')}>
      <Select value={category} onchange={(e) => list.set({ category: e.currentTarget.value })}>
        <option value="">{t('filters.any')}</option>
        {#each CATEGORIES as c (c)}
          <option value={c}>{enumLabel(t, 'ProductCategory', c)}</option>
        {/each}
      </Select>
    </Field>
  {/if}
  {#if dict === 'substances'}
    <Field id="filter-type" label={t('field.type')}>
      <Select value={type} onchange={(e) => list.set({ type: e.currentTarget.value })}>
        <option value="">{t('filters.any')}</option>
        {#each SUBSTANCE_TYPES as x (x)}
          <option value={x}>{enumLabel(t, 'SubstanceType', x)}</option>
        {/each}
      </Select>
    </Field>
  {/if}
  {#if SOFT.includes(dict)}
    <Checkbox
      checked={deleted}
      onchange={(e) => list.set({ includeDeleted: e.currentTarget.checked ? 'true' : null })}
    >
      {t('dict.showDeleted')}
    </Checkbox>
  {/if}
{/snippet}

<div style={STACK}>
  <PageToolbar
    search={{
      label: t('dict.search', { name: enumLabel(t, 'DictionaryName', dict) }),
      placeholder: t(`dict.searchPlaceholder.${dict}`),
      value: q,
      onchange: (text) => list.set({ q: text }),
    }}
    {count}
    filters={SOFT.includes(dict) || dict === 'products' || dict === 'substances' ? filters : undefined}
  />
  {#if !rows.data && rows.failed}
    <AreaFailed
      text={t('dict.failed')}
      busy={rows.fetching}
      onretry={() => void userAction(rows.refetch)}
      onreset={isBadListQuery(rows.error) ? list.reset : undefined}
    />
  {:else if !rows.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={rows.fetching} onreload={() => void userAction(rows.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-search" text={t('dict.empty')} />
      {/if}
    </Card>
  {:else}
    <div aria-busy={rows.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={enumLabel(t, 'DictionaryName', dict)}
        {columns}
        rows={items}
        rowKey={(e) => e.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
        actions={rowActions}
      />
      <Pagination page={list.page} size={SIZE} total={rows.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
  {#if editing}
    <EntryDialog name={dict} entry={editing} onclose={() => (editing = null)} />
  {/if}
  {#if removing}
    <DeleteEntryDialog name={dict} entry={removing} onclose={() => (removing = null)} />
  {/if}
  {#if photo}
    <PhotoDialog product={photo} onclose={() => (photo = null)} />
  {/if}
</div>
