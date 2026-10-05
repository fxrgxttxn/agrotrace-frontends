<script lang="ts">
  import { page } from '$app/state';
  import { enumLabel } from '@agrotrace/i18n';
  import { DICTIONARIES, type DictName } from '../../app/admin';
  import { goto } from '../../app/goto';
  import { t } from '../../app/i18n';
  import { skipRouteFocus } from '../../app/routeFocus';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import Tabs from '../../ui/Tabs.svelte';
  import DictionaryList from './DictionaryList.svelte';
  import EntryDialog from './EntryDialog.svelte';
  import ImportDialog from './ImportDialog.svelte';
  import ImportReportCard from './ImportReportCard.svelte';
  import { isDict, STACK, type Report } from './dictionaries';

  const name = $derived(page.params.name);
  let dialog = $state<'add' | 'import' | null>(null);
  let report = $state<{ name: DictName; report: Report } | null>(null);

  function select(id: string) {
    if (id === name) return;
    const to = `/admin/dictionaries/${id}`;
    skipRouteFocus(to);
    void goto(to, { keepFocus: true, noScroll: true });
  }
</script>

{#snippet pageActions()}
  <Button icon="upload" onclick={() => (dialog = 'import')}>{t('dict.import.open')}</Button>
  <Button variant="primary" icon="plus" onclick={() => (dialog = 'add')}>{t('dict.add')}</Button>
{/snippet}

{#snippet panel(id: string)}
  <div style="{STACK}; padding-top: var(--sp-4)">
    {#if report && report.name === id}
      <ImportReportCard name={id as DictName} report={report.report} onclose={() => (report = null)} />
    {/if}
    {#key id}
      <DictionaryList name={id as DictName} />
    {/key}
  </div>
{/snippet}

{#if !isDict(name)}
  <Page title={t('page.dictionaries')}>
    <Card>
      <Empty art="not-found" text={t('dict.notFound')}>
        {#snippet action()}<Button variant="primary" href="/admin/dictionaries/products">{t('dict.toProducts')}</Button
          >{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  {@const current = name}
  <Page title={t('page.dictionaries')} actions={pageActions}>
    <Tabs
      label={t('page.dictionaries')}
      tabs={DICTIONARIES.map((d) => ({ id: d, label: enumLabel(t, 'DictionaryName', d) }))}
      selected={current}
      onselect={select}
      {panel}
    />
    {#if dialog === 'add'}
      <EntryDialog name={current} onclose={() => (dialog = null)} />
    {/if}
    {#if dialog === 'import'}
      <ImportDialog
        name={current}
        onclose={() => (dialog = null)}
        ondone={(r) => {
          dialog = null;
          report = { name: current, report: r };
        }}
      />
    {/if}
  </Page>
{/if}
