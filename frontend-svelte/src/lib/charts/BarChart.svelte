<script lang="ts" generics="T">
  import { t } from '../app/i18n';
  import Table from '../ui/Table.svelte';
  import type { Column } from '../ui/table';
  import type { Bar } from './bars';
  import ChartCanvas from './ChartCanvas.svelte';

  /** `at-chart` (README «График»): the ECharts canvas (`role="img"` with a summary of every bar) and, under it, the same
   * values as a table in a collapsed `details` — tooltips enhance, the table is the keyboard and screen-reader view.
   * ECharts is its own lazy chunk (the dashboard page does not carry it); the chart is drawn again when the theme
   * changes (token values are read with getComputedStyle). As the React app's BarChart. */
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
    /** The card title: the canvas summary starts with it, the table caption is it. */
    title: string;
    bars: Bar[];
    /** Columns of the table view (`text` of each cell). */
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    /** A refetch is under way: the previous render stays, dimmed. */
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
