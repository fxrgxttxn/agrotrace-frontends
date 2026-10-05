<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel, formatDecimal, formatLocalDateTime, formatPercent } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { Idempotency } from '../../app/idempotency';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import AcceptForm from './AcceptForm.svelte';
  import DeleteDialog from './DeleteDialog.svelte';
  import RejectDialog from './RejectDialog.svelte';
  import { GAP, totalKg, WAYBILL_TONE, type Waybill } from './waybills';

  const id = $derived(page.params.id ?? '');
  const screen = screenScope();
  const alert = new FormAlert();
  const idempotentSend = new Idempotency();
  let sending = $state(false);
  const sendWait = new Countdown();
  let sendButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => sendWait.left,
    () => sendButton,
  );
  let dialog = $state<'delete' | 'reject' | null>(null);
  let deleted = $state(false);
  const refocus = { current: false };

  function reread() {
    refocus.current = true;
    void cache.invalidate(['waybill', id]);
    void cache.invalidate(['waybills']);
    void cache.invalidate(['batches']);
  }

  function describe(e: unknown): { text: string; tone: 'danger' | 'attention' } {
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return { text: t('waybills.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      const from = String(e.params?.from ?? '');
      return typeof e.params?.publicCode === 'string'
        ? {
            text: t('waybills.batchState', { publicCode: e.params.publicCode, status: enumLabel(t, 'BatchStatus', from) }),
            tone: 'danger',
          }
        : { text: t('waybills.stateChanged', { status: enumLabel(t, 'WaybillStatus', from) }), tone: 'danger' };
    }
    if (e instanceof ApiProblem && (e.rule === 'BR-06' || e.status === 404)) reread();
    return { text: errorText(e), tone: errorTone(e) };
  }
  function fail(e: unknown): { text: string; tone: 'danger' | 'attention' } {
    const p = describe(e);
    alert.show(p.text, p.tone);
    return p;
  }

  const waybillQuery = query(
    () => (deleted ? null : ['waybill', id]),
    ([, wid]) => call<Waybill>(session.api.GET('/waybills/{id}', { params: { path: { id: String(wid) } } })),
    { failed: 'waybills.failed' },
  );
  const waybill = $derived(waybillQuery.data);
  const notFound = $derived(!waybill && waybillQuery.error instanceof ApiProblem && waybillQuery.error.status === 404);
  const can = (a: string) => Boolean(waybill?.actions.includes(a as never));

  $effect(() => {
    if ((dialog === 'reject' && !can('reject')) || (dialog === 'delete' && !can('delete'))) dialog = null;
  });
  let wasFetching = false;
  $effect(() => {
    const fetching = waybillQuery.fetching;
    if (fetching) {
      wasFetching = true;
      return;
    }
    if (!wasFetching) return;
    wasFetching = false;
    if (!refocus.current) return;
    refocus.current = false;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        document.querySelector<HTMLElement>('h1.at-page__title')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  });

  function changed(next: Waybill) {
    waybillQuery.set(next, cache.generation);
    void cache.invalidate(['waybills']);
    void cache.invalidate(['batches']);
    void cache.invalidate(['batch']);
  }

  async function send(w: Waybill) {
    alert.clear();
    sending = true;
    try {
      const next = await idempotentSend.run({ id: w.id, version: w.version }, (key) =>
        call<Waybill>(
          session.api.POST('/waybills/{id}/send', {
            params: { path: { id: w.id }, header: { 'If-Match': w.version, 'Idempotency-Key': key } },
          }),
        ),
      );
      changed(next);
      screen.done({ tone: 'ok', text: t('waybills.sent', { number: next.number }) });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) sendWait.start(retryAfterOf(e));
      fail(e);
    } finally {
      sending = false;
    }
  }

  const accepted = $derived(waybill?.items.some((i) => i.massActualKg !== null) ?? false);
  const columns = $derived<Column<Waybill['items'][number]>[]>([
    { key: 'code', header: t('waybills.batch'), primary: true },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'declared', header: t('waybills.declared'), numeric: true },
    ...(accepted
      ? ([
          { key: 'actual', header: t('waybills.actual'), numeric: true },
          { key: 'discrepancy', header: t('waybills.discrepancy'), numeric: true },
          { key: 'act', header: t('waybills.act') },
        ] satisfies Column<Waybill['items'][number]>[])
      : []),
  ]);
</script>

{#snippet itemCell(i: Waybill['items'][number], c: Column<Waybill['items'][number]>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{i.batch.id}" code={i.batch.publicCode} sub={i.batch.product.name} />
  {:else if c.key === 'status'}
    <Chip status={i.batch.status} />
  {:else if c.key === 'declared'}{formatDecimal(i.massDeclaredKg, LOCALE)}{:else if c.key === 'actual'}{i.massActualKg
      ? formatDecimal(i.massActualKg, LOCALE)
      : '—'}{:else if c.key === 'discrepancy'}{i.discrepancyPercent
      ? formatPercent(i.discrepancyPercent, LOCALE)
      : '—'}{:else}{i.discrepancyAct ?? '—'}{/if}
{/snippet}

{#if notFound}
  <Page title={t('page.waybill')}>
    <Card>
      <Empty art="not-found" text={t('waybills.notFound')}>
        {#snippet action()}<Button variant="primary" href="/waybills">{t('waybills.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {#snippet pageActions()}
    {#if can('send')}
      <Button
        bind:element={sendButton}
        variant="primary"
        icon="truck"
        busy={sending}
        disabled={sendWait.left > 0}
        onclick={() => void userAction(() => send(waybill!))}
      >
        {sendWait.left > 0 ? t('auth.retryIn', { seconds: sendWait.left }) : enumLabel(t, 'WaybillActionName', 'send')}
      </Button>
    {/if}
    {#if can('delete')}
      <Button variant="secondary" onclick={() => (dialog = 'delete')}>{enumLabel(t, 'WaybillActionName', 'delete')}</Button>
    {/if}
    {#if can('reject')}
      <Button variant="secondary" onclick={() => (dialog = 'reject')}>{enumLabel(t, 'WaybillActionName', 'reject')}</Button>
    {/if}
  {/snippet}
  <Page actions={waybill && (can('send') || can('delete') || can('reject')) ? pageActions : undefined} title={waybill?.number ?? t('page.waybill')}>
    {#if !waybill && waybillQuery.failed}
      <AreaFailed text={t('waybills.failed')} busy={waybillQuery.fetching} onretry={() => void userAction(waybillQuery.refetch)} />
    {:else if !waybill}
      <AreaLoading />
    {:else}
      {@const w = waybill}
      {@const facts = [
        { key: 'sender', term: t('waybills.sender'), value: w.sender.name },
        { key: 'receiver', term: t('waybills.receiver'), value: w.receiver.name },
        { key: 'mass', term: t('waybills.mass'), value: formatDecimal(totalKg(w.items.map((i) => i.massDeclaredKg)), LOCALE) },
        { key: 'created', term: t('waybills.createdAt'), value: formatLocalDateTime(w.createdAt, LOCALE) },
        ...(w.sentAt ? [{ key: 'sent', term: t('waybills.sentAt'), value: formatLocalDateTime(w.sentAt, LOCALE) }] : []),
        ...(w.acceptedAt ? [{ key: 'accepted', term: t('waybills.acceptedAt'), value: formatLocalDateTime(w.acceptedAt, LOCALE) }] : []),
        ...(w.rejectReason ? [{ key: 'reason', term: t('waybills.rejectReason'), value: w.rejectReason }] : []),
      ]}
      <div style={GAP}>
        <Card>
          <CardHeader title={t('count.batches', { count: w.items.length })}>
            <Chip tone={WAYBILL_TONE[w.status]} size="l">{enumLabel(t, 'WaybillStatus', w.status)}</Chip>
          </CardHeader>
          <CardBody><CardFacts {facts} /></CardBody>
        </Card>
        <Table cards caption={t('waybills.items')} {columns} rows={w.items} rowKey={(i) => i.batch.id} cell={itemCell} />
        {#if can('accept')}
          {#key w.id}
            <AcceptForm
              waybill={w}
              {alert}
              {fail}
              ondone={(next) => {
                changed(next);
                screen.done({ tone: 'ok', text: t('waybills.accepted', { number: next.number }) });
              }}
            />
          {/key}
        {/if}
      </div>
    {/if}
  </Page>
  {#if waybill}
    <DeleteDialog
      open={dialog === 'delete'}
      waybill={waybill}
      {describe}
      onclose={() => (dialog = null)}
      ondone={() => {
        dialog = null;
        deleted = true;
        cache.forget(['waybill', waybill.id]);
        void cache.invalidate(['waybills']);
        screen.done({ tone: 'ok', text: t('waybills.deleted', { number: waybill.number }) });
        screen.navigate('/waybills');
      }}
    />
    <RejectDialog
      open={dialog === 'reject'}
      waybill={waybill}
      {describe}
      onclose={() => (dialog = null)}
      ondone={(next) => {
        dialog = null;
        changed(next);
        screen.done({ tone: 'ok', text: t('waybills.rejected', { number: next.number }) });
      }}
    />
  {/if}
{/if}
