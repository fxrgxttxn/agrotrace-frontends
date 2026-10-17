<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem, withVariant, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime, formatMass } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { goto } from '../../app/goto';
  import { LOCALE, t } from '../../app/i18n';
  import { withBase } from '../../app/paths';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import Tabs from '../../ui/Tabs.svelte';
  import { viewerOf } from '../viewer';
  import AssignLabDialog from './AssignLabDialog.svelte';
  import { ACTION_TARGET, GAP, TABS, type Batch, type Tab } from './batches';
  import BatchDocsTab from './BatchDocsTab.svelte';
  import BatchGraphTab from './BatchGraphTab.svelte';
  import BatchHistoryTab from './BatchHistoryTab.svelte';
  import BatchPathTab from './BatchPathTab.svelte';
  import BatchTestsTab from './BatchTestsTab.svelte';

  const id = $derived(page.params.id ?? '');
  const viewer = $derived(viewerOf(session.me!));
  const tab = $derived<Tab>(
    (TABS as readonly string[]).includes(page.url.searchParams.get('tab') ?? '')
      ? (page.url.searchParams.get('tab') as Tab)
      : 'history',
  );
  let assigning = $state(false);

  function showTab(next: Tab) {
    const q = new URLSearchParams(page.url.searchParams);
    if (next === 'history') q.delete('tab');
    else q.set('tab', next);
    const s = q.toString();
    void goto(`/batches/${id}${s ? `?${s}` : ''}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  const batchQuery = query(
    () => ['batch', id],
    ([, batchId]) => call<Batch>(session.api.GET('/batches/{id}', { params: { path: { id: String(batchId) } } })),
    { failed: 'batches.failed' },
  );
  const batch = $derived(batchQuery.data);
  const notFound = $derived(!batch && batchQuery.error instanceof ApiProblem && batchQuery.error.status === 404);

  const batchActions = $derived(
    (batch?.actions ?? [])
      .map((a) => ({ a, href: ACTION_TARGET[a.action]?.(batch!) }))
      .filter((x): x is { a: Schemas['BatchAction']; href: string } => Boolean(x.href && viewer.may(x.href))),
  );
</script>

{#if notFound}
  <Page title={t('page.batch')}>
    <Card>
      <Empty art="not-found" text={t('batches.notFound')}>
        {#snippet action()}
          <Button variant="primary" href={viewer.may('/batches') ? '/batches' : '/'}
            >{viewer.may('/batches') ? t('batches.toList') : t('action.home')}</Button
          >
        {/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {#snippet pageActions()}
    {#each batchActions as { a, href }, i (a.action)}
      <Button variant={i === 0 ? 'primary' : 'secondary'} {href}>{enumLabel(t, 'BatchActionName', a.action)}</Button>
    {/each}
    {#if viewer.inspector}
      <Button variant="secondary" icon="flask" onclick={() => (assigning = true)}>{t('lab.assign')}</Button>
    {/if}
  {/snippet}
  <Page actions={batch && (batchActions.length > 0 || viewer.inspector) ? pageActions : undefined} title={batch?.publicCode ?? t('page.batch')}>
    {#if !batch && batchQuery.failed}
      <AreaFailed text={t('batches.failed')} busy={batchQuery.fetching} onretry={() => void userAction(batchQuery.refetch)} />
    {:else if !batch}
      <AreaLoading />
    {:else}
      {@const b = batch}
      {@const fieldLink = viewer.may('/fields/x')}
      {#snippet holderFact()}
        <span style="display: inline-flex; align-items: center; gap: var(--sp-2)">
          <Avatar name={b.holder.name} src={b.holder.logoUrl ? withVariant(b.holder.logoUrl, 96) : null} size="s" shape="square" decorative />
          {b.holder.name}
        </span>
      {/snippet}
      {#snippet originFact()}
        <span style="display: inline-flex; align-items: center; gap: var(--sp-2)">
          <Avatar name={b.origin.name} src={b.origin.logoUrl ? withVariant(b.origin.logoUrl, 96) : null} size="s" shape="square" decorative />
          {b.origin.name}
        </span>
      {/snippet}
      {#snippet fieldFact()}
        <a href={withBase(`/fields/${b.field?.id}`)}>{b.field?.name}</a>
      {/snippet}
      {@const facts = [
        { key: 'product', term: t('batches.product'), value: b.product.name },
        { key: 'mass', term: t('batches.massValue'), value: formatMass(b.massKg, LOCALE) },
        { key: 'holder', term: t('batches.holder'), value: holderFact },
        ...(b.origin.id !== b.holder.id ? [{ key: 'origin', term: t('batches.origin'), value: originFact }] : []),
        ...(b.field ? [{ key: 'field', term: t('batches.field'), value: fieldLink ? fieldFact : b.field.name }] : []),
        b.harvestedAt
          ? { key: 'date', term: t('batches.harvestedAt'), value: formatLocalDateTime(b.harvestedAt, LOCALE) }
          : {
              key: 'date',
              term: t('batches.producedAt'),
              value: b.producedAt ? formatLocalDateTime(b.producedAt, LOCALE) : '—',
            },
        { key: 'kind', term: t('batches.kind'), value: enumLabel(t, 'BatchKind', b.kind) },
        ...(b.kind === 'RAW' ? [{ key: 'test', term: t('batches.test'), value: enumLabel(t, 'TestReason', b.testReason) }] : []),
      ]}
      <div style={GAP}>
        <Card>
          <CardHeader title={b.product.name}>
            <Chip status={b.status} size="l" />
          </CardHeader>
          <CardBody>
            <div style="display: flex; gap: var(--sp-5); align-items: flex-start; flex-wrap: wrap">
              {#if b.product.imageUrl}
                <Avatar name={b.product.name} src={withVariant(b.product.imageUrl, 96)} size="l" shape="square" decorative />
              {/if}
              <div style="flex: 1 1 16rem; min-width: 0">
                <CardFacts {facts} />
              </div>
            </div>
          </CardBody>
        </Card>
        <Tabs
          label={t('batches.tabs', { code: b.publicCode })}
          tabs={TABS.map((tid) => ({ id: tid, label: t(`batches.tab.${tid}`) }))}
          selected={tab}
          onselect={(next) => showTab(next as Tab)}
          panel={tabPanel}
        />
      </div>
    {/if}
  </Page>
  {#if batch && viewer.inspector}
    <AssignLabDialog
      open={assigning}
      {batch}
      onclose={() => (assigning = false)}
      ondone={() => {
        assigning = false;
        showTab('tests');
      }}
    />
  {/if}
{/if}

{#snippet tabPanel(which: string)}
  {#if batch}
    {#if which === 'history'}
      <BatchHistoryTab id={batch.id} />
    {:else if which === 'path'}
      <BatchPathTab id={batch.id} />
    {:else if which === 'graph'}
      <BatchGraphTab {batch} />
    {:else if which === 'tests'}
      <BatchTestsTab id={batch.id} labLinks={viewer.may('/lab/tests/x')} />
    {:else if which === 'docs'}
      <BatchDocsTab {batch} />
    {/if}
  {/if}
{/snippet}
