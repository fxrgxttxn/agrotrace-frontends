<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatDecimal, formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { addDays } from '../../app/dates';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams } from '../../app/listState.svelte';
  import { clock } from '../../app/now.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Empty from '../../ui/Empty.svelte';
  import ListChanged from '../../ui/ListChanged.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import { SIZE, TREATMENTS_SPEC, type FieldT, type Treatment } from './fields';
  import TreatmentDialog from './TreatmentDialog.svelte';

  let { field, farmer }: { field: FieldT; farmer: boolean } = $props();

  const substances = dictionary('substances');
  const list = listParams(() => `/fields/${field.id}`, TREATMENTS_SPEC);
  const time = clock();
  const screen = screenScope();
  let editing = $state<{ tr?: Treatment; key: number; open: boolean } | null>(null);

  function setEditing(target: Treatment | 'new' | null) {
    if (target !== null && !substances.data && substances.failed) {
      screen.push({ tone: 'danger', text: t('treatments.substancesFailed') });
      void substances.refetch();
      return;
    }
    editing =
      target === null
        ? editing && { ...editing, open: false }
        : { tr: target === 'new' ? undefined : target, key: (editing?.key ?? 0) + 1, open: true };
  }

  const treatments = query(
    () => ['treatments', field.id, list.page, list.params.get('sort')],
    ([, fieldId, pageNo, sort]) =>
      call<Schemas['TreatmentPage']>(
        session.api.GET('/fields/{id}/treatments', {
          params: {
            path: { id: String(fieldId) },
            query: { page: Number(pageNo), size: SIZE, ...(sort ? { sort: String(sort) } : {}) },
          },
        }),
      ),
    { failed: 'treatments.failed' },
  );
  const items = $derived(treatments.data?.items ?? []);
  $effect(() => {
    const data = treatments.data;
    if (data && data.items.length === 0 && data.total > 0) list.clampPage(data.total, SIZE);
  });
  const gap = $derived(treatments.data ? listGap(treatments.data, list.page, SIZE) : null);

  function refresh() {
    void cache.invalidate(['treatments', field.id]);
    void cache.invalidate(['field', field.id]);
    void cache.invalidate(['fields']);
  }

  let card: HTMLDivElement | null = $state(null);
  let addButton: HTMLElement | null = $state(null);
  let lastFocus: Element | null = null;
  $effect(() => {
    const el = card;
    if (!el) return;
    const on = (e: FocusEvent) => (lastFocus = e.target as Element);
    el.addEventListener('focus', on, true);
    const observer = new MutationObserver(() => {
      const last = lastFocus;
      if (!last || last.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      lastFocus = null;
      const title = card?.querySelector<HTMLElement>('.at-card__title');
      (addButton ?? title)?.focus();
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('focus', on, true);
      observer.disconnect();
    };
  });
  onDestroy(() => (lastFocus = null));

  const editable = (tr: Treatment) => farmer && time.now <= Date.parse(tr.editableUntil);
  const columns: Column<Treatment>[] = [
    { key: 'substance', header: t('field.substanceId'), primary: true },
    { key: 'dose', header: t('treatments.dose'), numeric: true },
    { key: 'applied', header: t('field.appliedAt'), sortField: 'appliedAt' },
    { key: 'wait', header: t('treatments.waitUntil') },
  ];
  const sortOptions = [
    { value: 'appliedAt,desc', label: t('treatments.sort.newest') },
    { value: 'appliedAt,asc', label: t('treatments.sort.oldest') },
  ];
</script>

{#snippet cell(tr: Treatment, c: Column<Treatment>)}
  {#if c.key === 'substance'}
    <span class="at-table__primary"
      ><span>{tr.substance.name}</span><span class="at-table__sub"
        >{enumLabel(t, 'SubstanceType', tr.substance.type)}</span
      ></span
    >
  {:else if c.key === 'dose'}{`${formatDecimal(tr.dose, LOCALE)} ${tr.doseUnit}`}{:else if c.key === 'applied'}{formatLocalDateTime(
      tr.appliedAt,
      LOCALE,
    )}{:else}{formatLocalDateTime(addDays(tr.appliedAt, tr.substance.waitingPeriodDays), LOCALE)}{/if}
{/snippet}

{#snippet rowActions(tr: Treatment)}
  {#if editable(tr)}
    <Button
      size="s"
      aria-label={t('treatments.editOf', {
        substance: tr.substance.name,
        date: formatLocalDate(tr.appliedAt, LOCALE),
      })}
      title={t('treatments.editableUntil', { time: formatLocalDateTime(tr.editableUntil, LOCALE) })}
      onclick={() => setEditing(tr)}>{t('treatments.edit')}</Button
    >
  {/if}
{/snippet}

<div bind:this={card}>
  <Card>
    <CardHeader title={t('treatments.title')}>
      {#if farmer && items.length > 0}
        <Button bind:element={addButton} icon="plus" onclick={() => setEditing('new')}>{t('treatments.add')}</Button>
      {/if}
    </CardHeader>
    <CardBody>
      {#if !treatments.data && treatments.failed}
        {#if isBadListQuery(treatments.error)}
          <Empty art="empty-search" text={t('filters.invalid')}>
            {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
          </Empty>
        {:else}
          <Empty art="empty-search" text={t('treatments.failed')}>
            {#snippet action()}
              <Button variant="primary" busy={treatments.fetching} onclick={() => void userAction(treatments.refetch)}
                >{t('action.retry')}</Button
              >
            {/snippet}
          </Empty>
        {/if}
      {:else if !treatments.data || gap === 'pastEnd'}
        <AreaLoading blocks={1} />
      {:else if gap === 'changed'}
        <ListChanged busy={treatments.fetching} onreload={() => void userAction(treatments.refetch)} />
      {:else if items.length === 0}
        <Empty art="empty-fields" text={t('treatments.empty')}>
          {#snippet action()}
            {#if farmer}
              <Button variant="primary" onclick={() => setEditing('new')}>{t('treatments.add')}</Button>
            {/if}
          {/snippet}
        </Empty>
      {:else}
        <div aria-busy={treatments.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
          <Table
            cards
            caption={t('treatments.title')}
            {columns}
            rows={items}
            rowKey={(tr) => tr.id}
            sort={list.sort}
            onsort={list.setSort}
            {sortOptions}
            actions={farmer ? rowActions : undefined}
            {cell}
          />
          <Pagination page={list.page} size={SIZE} total={treatments.data.total} hrefFor={list.hrefFor} />
        </div>
      {/if}
    </CardBody>
    {#if editing !== null && substances.data}
      {#key editing.key}
        <TreatmentDialog
          substances={substances.data}
          open={editing.open}
          fieldId={field.id}
          treatment={editing.tr}
          onclose={() => setEditing(null)}
          onsaved={(created) => {
            if (screen.alive()) setEditing(null);
            refresh();
            screen.done({ tone: 'ok', text: t(created ? 'treatments.created' : 'treatments.saved') });
          }}
          onclosedwindow={(until) => {
            if (screen.alive()) setEditing(null);
            refresh();
            screen.push({ tone: 'danger', text: t('treatments.editClosed', { time: formatLocalDateTime(until, LOCALE) }) });
          }}
        />
      {/key}
    {/if}
  </Card>
</div>
