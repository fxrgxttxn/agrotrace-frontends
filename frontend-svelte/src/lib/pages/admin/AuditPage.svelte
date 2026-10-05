<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams, type ListSpec } from '../../app/listState.svelte';
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
  import type { Column } from '../../ui/table';
  import DiffDialog from './DiffDialog.svelte';
  import IdFilter from './IdFilter.svelte';

  type Entry = Schemas['AuditEntry'];
  type EntityType = Schemas['AuditEntityType'];
  type Backend = Entry['backend'];

  const SIZE = 20;
  const STACK = 'display: grid; gap: var(--sp-4)';
  const ENTITY_TYPES: readonly EntityType[] = [
    'organization',
    'user',
    'field',
    'treatment',
    'batch',
    'waybill',
    'labTest',
    'recall',
    'recallTask',
    'complaint',
    'product',
    'substance',
    'indicator',
    'norm',
    'region',
    'file',
    'batchDocument',
  ];
  const BACKENDS: readonly Backend[] = ['express', 'django', 'laravel', 'seed', 'system'];
  const SPEC: ListSpec = {
    sort: ['createdAt'],
    enums: { entityType: ENTITY_TYPES, backend: BACKENDS },
    uuids: ['actorId', 'entityId'],
    dates: ['from', 'to'],
    patterns: { action: /^[A-Za-z0-9._-]{1,64}$/ },
  };
  const at = (iso: string) => formatLocalDateTime(iso, LOCALE);
  const short = (id: string) => id.slice(0, 8);

  const list = listParams(() => '/admin/audit', SPEC);
  const actionFilter = $derived(list.get('action'));
  const entityType = $derived(list.get('entityType'));
  const entityId = $derived(list.get('entityId'));
  const actorId = $derived(list.get('actorId'));
  const backend = $derived(list.get('backend'));
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived([entityType, entityId, actorId, backend, from, to].filter(Boolean).length);
  let viewing = $state<Entry | null>(null);
  function hrefWith(patch: Record<string, string>): string {
    const next = new URLSearchParams(list.params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    next.delete('page');
    return `/admin/audit?${next.toString()}`;
  }

  const log = query(
    () => ['audit', list.page, list.params.get('sort'), actionFilter, entityType, entityId, actorId, backend, from, to],
    ([, pageNo, sort, act, et, eid, aid, be, f, until]) =>
      call<Schemas['AuditPage']>(
        session.api.GET('/audit-log', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(act ? { action: String(act) } : {}),
              ...(et ? { entityType: et as EntityType } : {}),
              ...(eid ? { entityId: String(eid) } : {}),
              ...(aid ? { actorId: String(aid) } : {}),
              ...(be ? { backend: be as Backend } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'audit.failed' },
  );
  const items = $derived(log.data?.items ?? []);
  const gap = $derived(log.data ? listGap(log.data, list.page, SIZE) : null);
  $effect(() => {
    const data = log.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const columns: Column<Entry>[] = [
    { key: 'time', header: t('audit.time'), primary: true, sortField: 'createdAt' },
    { key: 'actor', header: t('audit.actor') },
    { key: 'entity', header: t('audit.entity') },
    { key: 'backend', header: t('audit.backend') },
  ];
  const sortOptions = [
    { value: 'createdAt,desc', label: t('audit.sort.newest') },
    { value: 'createdAt,asc', label: t('audit.sort.oldest') },
  ];
</script>

{#snippet cell(e: Entry, c: Column<Entry>)}
  {#if c.key === 'time'}
    <span class="at-table__primary"><span>{at(e.createdAt)}</span><span class="at-table__sub at-mono">{e.action}</span></span>
  {:else if c.key === 'actor'}
    {#if e.actor}<span class="at-table__primary"
        ><a href={hrefWith({ actorId: e.actor.id })} aria-label={t('audit.byActor', { name: e.actor.fullName })}
          >{e.actor.fullName}</a
        ><span class="at-table__sub">{e.actor.organization.name}</span></span
      >{:else}{t('audit.system')}{/if}
  {:else if c.key === 'entity'}
    <span class="at-table__primary"
      ><span>{enumLabel(t, 'AuditEntityType', e.entityType)}</span>{#if e.entityId}<a
          class="at-mono"
          href={hrefWith({ entityType: e.entityType, entityId: e.entityId })}
          aria-label={t('audit.byEntity', { entity: enumLabel(t, 'AuditEntityType', e.entityType), id: e.entityId })}
          >{short(e.entityId)}</a
        >{/if}</span
    >
  {:else}
    {enumLabel(t, 'AuditEntry.backend', e.backend)}
  {/if}
{/snippet}

{#snippet rowActions(e: Entry)}
  <Button size="s" aria-label={t('audit.diffOf', { id: e.id })} onclick={() => (viewing = e)}>{t('audit.diff')}</Button>
{/snippet}

{#snippet filters()}
  <Field id="filter-entity" label={t('audit.entity')}>
    <Select value={entityType} onchange={(e) => list.set({ entityType: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each ENTITY_TYPES as x (x)}
        <option value={x}>{enumLabel(t, 'AuditEntityType', x)}</option>
      {/each}
    </Select>
  </Field>
  <IdFilter id="filter-entity-id" label={t('audit.entityId')} value={entityId} onchange={(v) => list.set({ entityId: v })} />
  <IdFilter id="filter-actor" label={t('audit.actorId')} value={actorId} onchange={(v) => list.set({ actorId: v })} />
  <Field id="filter-backend" label={t('audit.backend')}>
    <Select value={backend} onchange={(e) => list.set({ backend: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each BACKENDS as x (x)}
        <option value={x}>{enumLabel(t, 'AuditEntry.backend', x)}</option>
      {/each}
    </Select>
  </Field>
  <DateFilter id="filter-from" label={t('audit.from')} value={from} max={to || undefined} onchange={(v) => list.set({ from: v })} />
  <DateFilter id="filter-to" label={t('audit.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

<Page title={t('page.audit')}>
  <PageToolbar
    search={{
      label: t('audit.action'),
      placeholder: t('audit.actionPlaceholder'),
      value: actionFilter,
      onchange: (text) => list.set({ action: text.trim() }),
    }}
    {count}
    {filters}
  />
  {#if !log.data && log.failed}
    <AreaFailed
      text={t('audit.failed')}
      busy={log.fetching}
      onretry={() => void userAction(log.refetch)}
      onreset={isBadListQuery(log.error) ? list.reset : undefined}
    />
  {:else if !log.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={log.fetching} onreload={() => void userAction(log.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if actionFilter || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-search" text={t('audit.empty')} />
      {/if}
    </Card>
  {:else}
    <div aria-busy={log.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={t('page.audit')}
        {columns}
        rows={items}
        rowKey={(e) => String(e.id)}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
        actions={rowActions}
      />
      <Pagination page={list.page} size={SIZE} total={log.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
  <DiffDialog entry={viewing} onclose={() => (viewing = null)} />
</Page>
