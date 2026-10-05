<script lang="ts">
  import { t } from '../../app/i18n';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import { indicatorText, normText, type LabResult, type LabTest, type Norm } from './lab';

  let { test }: { test: LabTest } = $props();

  const normColumns: Column<Norm>[] = [
    { key: 'name', header: t('lab.indicator'), primary: true, text: (n) => n.name },
    { key: 'norm', header: t('lab.norm'), text: (n) => normText(n.maxValue, n.unit) },
  ];
  const resultColumns: Column<LabResult>[] = [
    { key: 'name', header: t('lab.indicator'), primary: true },
    { key: 'assessment', header: t('lab.assessment'), status: true },
    { key: 'value', header: t('lab.value'), numeric: true },
    { key: 'norm', header: t('lab.norm') },
  ];
</script>

{#snippet resultCell(r: LabResult, c: Column<LabResult>)}
  {#if c.key === 'name'}{r.name}{:else if c.key === 'assessment'}{#if r.isExceeded}<Chip tone="danger"
        >{t('lab.exceeded')}</Chip
      >{:else}<Chip tone="ok">{t('lab.within')}</Chip>{/if}{:else if c.key === 'value'}{`${indicatorText(r.value)} ${r.unit}`}{:else}{normText(
      r.normValue,
      r.unit,
    )}{/if}
{/snippet}

{#if test.results.length > 0 || test.norms.length > 0}
  <Card>
    <CardHeader title={t('lab.results')} />
    <CardBody>
      {#if test.results.length === 0}
        <Table cards caption={t('lab.results')} columns={normColumns} rows={test.norms} rowKey={(n) => n.indicatorId} />
      {:else}
        <Table
          cards
          caption={t('lab.results')}
          columns={resultColumns}
          rows={test.results}
          rowKey={(r) => r.indicatorId}
          cell={resultCell}
        />
      {/if}
    </CardBody>
  </Card>
{/if}
