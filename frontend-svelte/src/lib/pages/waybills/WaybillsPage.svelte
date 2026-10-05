<script lang="ts">
  import { untrack } from 'svelte';
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
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
  import {
    OVERSEER_SPEC,
    PARTICIPANT_SPEC,
    SEVERAL,
    SIZE,
    totalKg,
    WAYBILL_STATUSES,
    WAYBILL_TONE,
    type Waybill,
    type WaybillStatus,
  } from './waybills';

  const me = $derived(session.me!);
  const overseer = $derived(!me.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR' || r === 'RETAILER'));
  const sender = $derived(me.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR'));
  const list = listParams(() => '/waybills', untrack(() => (overseer ? OVERSEER_SPEC : PARTICIPANT_SPEC)));
  const q = $derived(list.get('q'));
  const status = $derived(list.params.getAll('status'));
  const direction = $derived(overseer ? '' : list.get('direction'));
  const counterpartyOrgId = $derived(overseer ? list.get('counterpartyOrgId') : '');
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const count = $derived((status.length ? 1 : 0) + [direction, counterpartyOrgId, from, to].filter(Boolean).length);

  const waybills = query(
    () => ['waybills', list.page, list.params.get('sort'), q, status.join(','), direction, counterpartyOrgId, from, to],
    ([, pageNo, sort, text, statuses, dir, org, f, until]) =>
      call<Schemas['WaybillPage']>(
        session.api.GET('/waybills', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(statuses ? { status: String(statuses).split(',') as WaybillStatus[] } : {}),
              ...(dir ? { direction: dir as 'incoming' | 'outgoing' } : {}),
              ...(org ? { counterpartyOrgId: String(org) } : {}),
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'waybills.failed' },
  );
  const items = $derived(waybills.data?.items ?? []);
  $effect(() => {
    const data = waybills.data;
    if (data && data.items.length === 0 && data.total > 0) list.clampPage(data.total, SIZE);
  });
  const gap = $derived(waybills.data ? listGap(waybills.data, list.page, SIZE) : null);

  const columns: Column<Waybill>[] = [
    { key: 'number', header: t('waybills.number'), primary: true, sortField: 'number' },
    { key: 'status', header: t('waybills.status'), status: true },
    { key: 'sender', header: t('waybills.sender') },
    { key: 'receiver', header: t('waybills.receiver') },
    { key: 'mass', header: t('waybills.mass'), numeric: true },
    { key: 'created', header: t('waybills.createdAt'), sortField: 'createdAt' },
    { key: 'sent', header: t('waybills.sentAt'), sortField: 'sentAt' },
  ];
  const sortOptions = [
    { value: 'createdAt,desc', label: t('waybills.sort.created') },
    { value: 'number,asc', label: t('waybills.sort.number') },
    { value: 'sentAt,desc', label: t('waybills.sort.sent') },
    { value: 'acceptedAt,desc', label: t('waybills.sort.accepted') },
  ];
</script>

{#snippet cell(w: Waybill, c: Column<Waybill>)}
  {#if c.key === 'number'}
    <TablePrimary href="/waybills/{w.id}" code={w.number} sub={t('count.batches', { count: w.items.length })} />
  {:else if c.key === 'status'}
    <Chip tone={WAYBILL_TONE[w.status]}>{enumLabel(t, 'WaybillStatus', w.status)}</Chip>
  {:else if c.key === 'sender'}{w.sender.name}{:else if c.key === 'receiver'}{w.receiver.name}{:else if c.key === 'mass'}{formatDecimal(
      totalKg(w.items.map((i) => i.massDeclaredKg)),
      LOCALE,
    )}{:else if c.key === 'created'}{formatLocalDateTime(w.createdAt, LOCALE)}{:else}{w.sentAt
      ? formatLocalDateTime(w.sentAt, LOCALE)
      : '—'}{/if}
{/snippet}

{#snippet filters()}
  {#if !overseer}
    <Field id="filter-direction" label={t('waybills.direction')}>
      <Select value={direction} onchange={(e) => list.set({ direction: e.currentTarget.value })}>
        <option value="">{t('filters.any')}</option>
        <option value="incoming">{t('waybillDirection.incoming')}</option>
        <option value="outgoing">{t('waybillDirection.outgoing')}</option>
      </Select>
    </Field>
  {/if}
  <Field id="filter-status" label={t('waybills.status')}>
    <Select
      value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
      onchange={(e) => list.set({ status: e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      {#if status.length > 1}
        <option value={SEVERAL} disabled>{t('filters.several', { count: status.length })}</option>
      {/if}
      {#each WAYBILL_STATUSES as s (s)}
        <option value={s}>{enumLabel(t, 'WaybillStatus', s)}</option>
      {/each}
    </Select>
  </Field>
  {#if overseer}
    <OrgPicker
      id="filter-counterparty"
      label={t('waybills.counterparty')}
      value={counterpartyOrgId}
      onchange={(id) => list.set({ counterpartyOrgId: id })}
    />
  {/if}
  <DateFilter id="filter-from" label={t('waybills.from')} value={from} max={to || undefined} onchange={(v) => list.set({ from: v })} />
  <DateFilter id="filter-to" label={t('waybills.to')} value={to} min={from || undefined} onchange={(v) => list.set({ to: v })} />
{/snippet}

{#snippet pageActions()}
  <Button variant="primary" icon="plus" href="/waybills/new">{t('action.createWaybill')}</Button>
{/snippet}
<Page actions={sender ? pageActions : undefined} title={t('page.waybills')}>
  <PageToolbar
    search={{ label: t('waybills.search'), placeholder: t('waybills.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
    {count}
    {filters}
  />
  {#if !waybills.data && waybills.failed}
    <AreaFailed
      text={t('waybills.failed')}
      busy={waybills.fetching}
      onretry={() => void userAction(waybills.refetch)}
      onreset={isBadListQuery(waybills.error) ? list.reset : undefined}
    />
  {:else if !waybills.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={waybills.fetching} onreload={() => void userAction(waybills.refetch)} />
  {:else if items.length === 0}
    <Card>
      {#if q || count}
        <Empty art="empty-search" text={t('empty.search')}>
          {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
        </Empty>
      {:else}
        <Empty art="empty-waybills" text={t('empty.waybills')}>
          {#snippet action()}
            <Button variant="primary" href={sender ? '/waybills/new' : '/'}>{sender ? t('action.createWaybill') : t('action.home')}</Button>
          {/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={waybills.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.waybills')}
        {columns}
        rows={items}
        rowKey={(w) => w.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
      />
      <Pagination page={list.page} size={SIZE} total={waybills.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
</Page>
