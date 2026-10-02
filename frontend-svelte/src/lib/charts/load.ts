import type * as Charts from './echarts';

/** One request for the chart chunk per document, however many charts mount. A failed dynamic import stays failed in
 * this document (browsers keep the failed module), so it is not asked again: «Повторить» loads the page anew through
 * the reload-once guard (ruling FM15). As the React app's loader (src/charts/BarChart.tsx there). */
let loading: Promise<typeof Charts> | null = null;

export function loadCharts(): Promise<typeof Charts> {
  loading ??= import('./echarts');
  return loading;
}
