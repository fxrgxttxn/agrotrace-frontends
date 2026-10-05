<script lang="ts">
  import { tick } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
  import { call, errorText, errorTone } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { DialogAlert } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery } from '../../app/listState.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
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
  import { ownBatches, QR_SPEC, qrStatuses, SEVERAL, SIZE, type BatchItem } from '../stock/stock.svelte';
  import QrView from './QrView.svelte';

  const me = session.me!;
  const processor = me.roles.some((r) => r === 'PROCESSOR');
  const statuses = qrStatuses(processor);
  const own = ownBatches('/qr', statuses, QR_SPEC, 'qr.failed');
  const screen = screenScope();
  let busyId = $state<string | null>(null);
  let shown = $state<{ batch: BatchItem; links: Schemas['QrLinks'] | null } | null>(null);
  let justGenerated: string | null = $state(null);

  const failure = new DialogAlert();

  async function generate(b: BatchItem, inDialog = false) {
    busyId = b.id;
    failure.clear();
    try {
      const links = await call<Schemas['QrLinks']>(session.api.POST('/batches/{id}/qr', { params: { path: { id: b.id } }, body: {} }));
      const now = new Date().toISOString();
      const list = own.batches.data;
      if (list) {
        const i = list.items.findIndex((x) => x.id === b.id);
        if (i >= 0) list.items[i] = { ...list.items[i]!, qrGeneratedAt: now };
      }
      void cache.invalidate(['batches']);
      void cache.invalidate(['batch', b.id, 'documents']);
      screen.done({ tone: 'ok', text: t('qr.done', { code: b.publicCode }) });
      justGenerated = b.publicCode;
      shown = { batch: { ...b, qrGeneratedAt: now }, links };
    } catch (e) {
      if (e instanceof ApiProblem && (e.status === 403 || e.status === 404)) void cache.invalidate(['batches']);
      if (inDialog) failure.show(errorText(e), errorTone(e));
      else screen.push({ tone: errorTone(e), text: errorText(e) });
    } finally {
      busyId = null;
    }
  }

  function closeDialog() {
    failure.handOff();
    const code = justGenerated === shown?.batch.publicCode ? justGenerated : null;
    justGenerated = null;
    shown = null;
    if (!code) return;
    void tick().then(() => {
      document.querySelector<HTMLElement>(`[aria-label="${t('qr.downloadOf', { code })}"]`)?.focus();
    });
  }

  const columns: Column<BatchItem>[] = [
    { key: 'code', header: t('batches.code'), primary: true, sortField: 'publicCode' },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'qr', header: t('qr.state') },
    { key: 'updated', header: t('batches.updatedAt'), sortField: 'updatedAt' },
  ];
  const sortOptions = [
    { value: 'updatedAt,desc', label: t('batches.sort.updated') },
    { value: 'publicCode,asc', label: t('batches.sort.code') },
  ];
</script>

{#snippet cell(b: BatchItem, c: Column<BatchItem>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{b.id}" code={b.publicCode} sub={b.product.name} />
  {:else if c.key === 'status'}
    <Chip status={b.status} />
  {:else if c.key === 'qr'}{b.qrGeneratedAt
      ? t('qr.generatedAt', { date: formatLocalDate(b.qrGeneratedAt, LOCALE) })
      : t('qr.notGenerated')}{:else}{formatLocalDateTime(b.updatedAt, LOCALE)}{/if}
{/snippet}

{#snippet rowActions(b: BatchItem)}
  {#if b.qrGeneratedAt}
    <Button size="s" icon="download" aria-label={t('qr.downloadOf', { code: b.publicCode })} onclick={() => (shown = { batch: b, links: null })}>
      {t('qr.download')}
    </Button>
  {:else}
    <Button
      size="s"
      variant="primary"
      icon="qr"
      busy={busyId === b.id}
      aria-label={t('qr.generateOf', { code: b.publicCode })}
      onclick={() => void userAction(() => generate(b))}
    >
      {t('action.generateQr')}
    </Button>
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
{/snippet}

<Page title={t('page.qr')}>
  <PageToolbar
    search={{ label: t('qr.search'), placeholder: t('qr.searchPlaceholder'), value: own.q, onchange: (text) => own.list.set({ q: text }) }}
    count={own.count}
    {filters}
  />
  {#if !own.batches.data && own.batches.failed}
    <AreaFailed
      text={t('qr.failed')}
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
        <Empty art="empty-batches" text={t('qr.empty')}>
          {#snippet action()}<Button variant="primary" href="/stock">{t('nav.stock')}</Button>{/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={own.batches.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.qr')}
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
  <Dialog
    open={shown !== null}
    onclose={closeDialog}
    lightDismiss
    title={shown ? t('qr.title', { code: shown.batch.publicCode }) : ''}
  >
    {#snippet actions()}
      {#if shown && !shown.links}
        <Button busy={busyId === shown.batch.id} onclick={() => void generate(shown!.batch, true)}>
          {t('qr.regenerate')}
        </Button>
      {/if}
    {/snippet}
    {#if shown}<DialogMessage text={failure.message} /><QrView batch={shown.batch} links={shown.links} />{/if}
  </Dialog>
</Page>
