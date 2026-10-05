import type * as Charts from './echarts';

let loading: Promise<typeof Charts> | null = null;

export function loadCharts(): Promise<typeof Charts> {
  loading ??= import('./echarts');
  return loading;
}
