<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { formatDecimal } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { session } from '../../app/session.svelte';
  import FieldMap from '../../maps/FieldMap.svelte';
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
  import type { Column } from '../../ui/table';
  import { viewerOf } from '../viewer';
  import { dateOrDash, FIELDS_SPEC, GAP, SIZE, type FieldT } from './fields';

  const viewer = $derived(viewerOf(session.me!));
  const list = listParams(() => '/fields', FIELDS_SPEC);
  const q = $derived(list.get('q'));
  const regionCode = $derived(list.get('regionCode'));
  const organizationId = $derived(viewer.overseer ? list.get('organizationId') : '');
  const regions = dictionary('regions');

  const fields = query(
    () => ['fields', list.page, list.params.get('sort'), q, regionCode, organizationId],
    ([, pageNo, sort, text, region, org]) =>
      call<Schemas['FieldPage']>(
        session.api.GET('/fields', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(region ? { regionCode: String(region) } : {}),
              ...(org ? { organizationId: String(org) } : {}),
            },
          },
        }),
      ),
    { failed: 'fields.failed' },
  );
  const items = $derived(fields.data?.items ?? []);
  const filtered = $derived(Boolean(q || regionCode || organizationId));
  $effect(() => {
    const data = fields.data;
    if (data && data.items.length === 0 && data.total > 0) list.clampPage(data.total, SIZE);
  });
  const gap = $derived(fields.data ? listGap(fields.data, list.page, SIZE) : null);

  const columns: Column<FieldT>[] = $derived([
    { key: 'name', header: t('field.name'), primary: true, sortField: 'name' },
    ...(viewer.overseer ? [{ key: 'farm', header: t('fields.farm') }] : []),
    { key: 'area', header: t('fields.area'), numeric: true, sortField: 'areaHa' },
    { key: 'last', header: t('fields.lastTreatment'), sortField: 'lastTreatmentAt' },
    { key: 'count', header: t('fields.treatments'), numeric: true },
  ]);
  const sortOptions = [
    { value: 'name,asc', label: t('fields.sort.name') },
    { value: 'areaHa,desc', label: t('fields.sort.areaDesc') },
    { value: 'areaHa,asc', label: t('fields.sort.areaAsc') },
    { value: 'lastTreatmentAt,desc', label: t('fields.sort.lastTreatment') },
  ];
</script>

{#snippet cell(f: FieldT, c: Column<FieldT>)}
  {#if c.key === 'name'}
    <span class="at-table__primary"
      ><a href="/fields/{f.id}">{f.name}</a><span class="at-table__sub">{f.region.name}</span></span
    >
  {:else if c.key === 'farm'}{f.organization.name}{:else if c.key === 'area'}{formatDecimal(
      f.areaHa,
      LOCALE,
    )}{:else if c.key === 'last'}{dateOrDash(f.lastTreatmentAt)}{:else}{String(f.treatmentsCount)}{/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-region" label={t('fields.region')}>
    <Select value={regionCode} onchange={(e) => list.set({ regionCode: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each regions.data ?? [] as r (r.id)}
        <option value={r.code}>{r.name}</option>
      {/each}
    </Select>
  </Field>
  {#if viewer.overseer}
    <OrgPicker
      id="filter-org"
      label={t('fields.farm')}
      types={['FARM']}
      value={organizationId}
      onchange={(id) => list.set({ organizationId: id })}
    />
  {/if}
{/snippet}

{#snippet pageActions()}
  <Button variant="primary" icon="plus" href="/fields/new">{t('fields.add')}</Button>
{/snippet}
<Page actions={viewer.farmer ? pageActions : undefined} title={t('page.fields')}>
  <PageToolbar
    search={{
      label: t('fields.search'),
      placeholder: t('fields.searchPlaceholder'),
      value: q,
      onchange: (text) => list.set({ q: text }),
    }}
    count={[regionCode, organizationId].filter(Boolean).length}
    {filters}
  />
  {#if !fields.data && fields.failed}
    <AreaFailed
      text={t('fields.failed')}
      busy={fields.fetching}
      onretry={() => void userAction(fields.refetch)}
      onreset={isBadListQuery(fields.error) ? list.reset : undefined}
    />
  {:else if !fields.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={fields.fetching} onreload={() => void userAction(fields.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if filtered}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-fields" text={t('empty.fields')}>
          {#snippet action()}
            {#if viewer.farmer}
              <Button variant="primary" href="/fields/new">{t('fields.add')}</Button>
            {:else}
              <Button variant="primary" href="/">{t('action.home')}</Button>
            {/if}
          {/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={fields.fetching ? 'true' : undefined} style={GAP}>
      <FieldMap fields={items} />
      <Table
        cards
        caption={t('page.fields')}
        {columns}
        rows={items}
        rowKey={(f) => f.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={fields.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
