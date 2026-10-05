<script lang="ts" generics="T">
  import { t } from '../app/i18n';
  import Table from '../ui/Table.svelte';
  import type { Column } from '../ui/table';
  import type { Bar } from './bars';
  import ChartCanvas from './ChartCanvas.svelte';

  let {
    title,
    bars,
    columns,
    rows,
    rowKey,
    busy = false,
    integer = false,
    axisFormat,
  }: {
    title: string;
    bars: Bar[];
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    busy?: boolean;
    integer?: boolean;
    axisFormat?: (value: number) => string;
  } = $props();
</script>

<div class="at-chart" aria-busy={busy ? 'true' : undefined} style="--at-chart-rows: {bars.length}">
  <ChartCanvas {title} {bars} {integer} {axisFormat} />
  <details class="at-chart__data">
    <summary class="at-chart__data-toggle">{t('dashboard.table')}</summary>
    <Table cards caption={title} {columns} {rows} {rowKey} />
  </details>
</div>
