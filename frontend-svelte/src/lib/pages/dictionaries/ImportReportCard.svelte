<script lang="ts">
  import { enumLabel } from '@agrotrace/i18n';
  import type { DictName } from '../../app/admin';
  import { t } from '../../app/i18n';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Metric from '../../ui/Metric.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import { COLUMN_LABEL, STACK, type Report } from './dictionaries';

  let { name, report, onclose }: { name: DictName; report: Report; onclose: () => void } = $props();

  const REPORT_ROWS = 200;
  const METRICS =
    'display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))';
  type Row = Report['errors'][number] & { key: string };
  const rejected = $derived(new Set(report.errors.map((x) => x.row)).size);
  let page = $state(1);
  $effect.pre(() => {
    void report;
    page = 1;
  });
  const shown = $derived<Row[]>(
    report.errors
      .slice((page - 1) * REPORT_ROWS, page * REPORT_ROWS)
      .map((x, i) => ({ ...x, key: `${x.row}-${x.column ?? ''}-${(page - 1) * REPORT_ROWS + i}` })),
  );
  const columns: Column<Row>[] = [
    { key: 'row', header: t('dict.report.row'), numeric: true },
    { key: 'column', header: t('dict.report.column') },
    { key: 'message', header: t('dict.report.message') },
  ];
</script>

{#snippet cell(x: Row, c: Column<Row>)}
  {#if c.key === 'row'}
    {x.row}
  {:else if c.key === 'column'}
    {#if x.column}<span class="at-table__primary"
        ><span>{COLUMN_LABEL[x.column] ? t(COLUMN_LABEL[x.column]!) : x.column}</span><span
          class="at-table__sub at-mono">{x.column}</span
        ></span
      >{:else}{t('dict.report.wholeRow')}{/if}
  {:else}
    {t(x.message)}
  {/if}
{/snippet}

<Card>
  <CardHeader title={t('dict.report.title', { name: enumLabel(t, 'DictionaryName', name) })}>
    <Button variant="ghost" iconOnly icon="close" aria-label={t('dict.report.close')} onclick={onclose} />
  </CardHeader>
  <CardBody>
    <div style={STACK}>
      <div style={METRICS}>
        <Metric label={t('dict.report.created')} value={String(report.created)} />
        <Metric label={t('dict.report.updated')} value={String(report.updated)} />
        <Metric label={t('dict.report.unchanged')} value={String(report.unchanged)} />
        <Metric label={t('dict.report.rejected')} value={String(rejected)} tone={rejected ? 'danger' : undefined} />
      </div>
      {#if shown.length > 0}
        <Table cards caption={t('dict.report.errors')} {columns} rows={shown} rowKey={(x) => x.key} {cell} />
      {/if}
      {#if report.errors.length > REPORT_ROWS}
        <Pagination
          {page}
          size={REPORT_ROWS}
          total={report.errors.length}
          label={t('dict.report.pages')}
          onpage={(p) => (page = p)}
        />
      {/if}
    </div>
  </CardBody>
</Card>
