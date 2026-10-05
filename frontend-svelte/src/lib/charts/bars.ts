export interface Bar {
  key: string;
  label: string;
  value: number;
  display: string;
}

export interface ChartColors {
  series: string;
  seriesHover: string;
  grid: string;
  axis: string;
  ink: string;
  surface: string;
  band: string;
  font: string;
}

export function readChartColors(get: (name: string) => string): ChartColors {
  return {
    series: get('--c-field'),
    seriesHover: get('--c-field-hover'),
    grid: get('--c-line'),
    axis: get('--c-ink-muted'),
    ink: get('--c-ink'),
    surface: get('--c-surface'),
    band: get('--c-surface-sunk'),
    font: get('--font-body'),
  };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export function chartSummary(title: string, bars: readonly Bar[]): string {
  return `${title}: ${bars.map((b) => `${b.label} — ${b.display}`).join('; ')}`;
}

export interface BarLayout {
  width: number;
  reducedMotion: boolean;
  integer?: boolean;
  axisFormat?: (value: number) => string;
}

export const BAR_MAX_WIDTH = 20;
export const NARROW = 480;
export const BAR_MAX_WIDTH_NARROW = 12;

export function barOptions(bars: readonly Bar[], c: ChartColors, layout: BarLayout): Record<string, unknown> {
  const narrow = layout.width < NARROW;
  const labelWidth = Math.max(72, Math.min(240, Math.round(layout.width * 0.5)));
  const text = { fontFamily: c.font, fontSize: 12 };
  return {
    animation: !layout.reducedMotion,
    animationDuration: 150,
    animationDurationUpdate: 150,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    aria: { enabled: false },
    grid: narrow
      ? { left: 12, right: 56, top: 16, bottom: 4, containLabel: true }
      : { left: 8, right: 56, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow', shadowStyle: { color: c.band, opacity: 0.7 } },
      className: 'at-chart__tooltip',
      backgroundColor: c.surface,
      borderColor: c.grid,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { ...text, color: c.ink, fontSize: 13 },
      formatter: (params: { dataIndex: number }[]) => {
        const bar = bars[params[0]?.dataIndex ?? -1];
        return bar ? `<strong>${escapeHtml(bar.display)}</strong><br>${escapeHtml(bar.label)}` : '';
      },
    },
    xAxis: {
      type: 'value',
      ...(layout.integer ? { minInterval: 1 } : {}),
      splitNumber: narrow ? 3 : 5,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        ...text,
        color: c.axis,
        hideOverlap: true,
        ...(layout.axisFormat ? { formatter: layout.axisFormat } : {}),
      },
      splitLine: { lineStyle: { color: c.grid, width: 1, type: 'solid' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: bars.map((b) => b.label),
      axisLine: { lineStyle: { color: c.grid, width: 1 } },
      axisTick: { show: false },
      axisLabel: narrow
        ? {
            ...text,
            color: c.axis,
            inside: true,
            align: 'left',
            verticalAlign: 'bottom',
            padding: [0, 0, 10, 0],
            margin: 0,
            width: Math.max(72, layout.width - 64),
            overflow: 'truncate',
            ellipsis: '…',
          }
        : { ...text, color: c.axis, width: labelWidth, overflow: 'truncate', ellipsis: '…' },
    },
    series: [
      {
        type: 'bar',
        data: bars.map((b) => b.value),
        barMaxWidth: narrow ? BAR_MAX_WIDTH_NARROW : BAR_MAX_WIDTH,
        itemStyle: { color: c.series, borderRadius: [0, 4, 4, 0] },
        emphasis: { itemStyle: { color: c.seriesHover } },
        label: {
          show: true,
          position: 'right',
          ...text,
          color: c.ink,
          formatter: (p: { dataIndex: number }) => bars[p.dataIndex]?.display ?? '',
        },
      },
    ],
  };
}
