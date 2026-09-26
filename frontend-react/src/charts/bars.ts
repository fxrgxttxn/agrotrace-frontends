// Options of the `at-chart` bar chart (README «График»), independent of ECharts itself (no import of the library:
// this module is in the page chunk, the library in its own lazy chunk). Rules of the `dataviz` skill: nominal
// categories are ONE series in ONE colour (`--c-field`), thin bars with a rounded data end and a square baseline,
// solid hairline grid in `--c-line`, axis text `--c-ink-muted`, the value at the bar's tip in `--c-ink` (text never
// wears the series colour), the whole band is the hover target, the tooltip leads with the value.

export interface Bar {
  key: string;
  /** Category name (from the API: never inserted as HTML). */
  label: string;
  value: number;
  /** The value as shown at the tip, in the tooltip and in the summary (`12,50%`, `3`). */
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

/** Token values of the current theme (`getComputedStyle(document.documentElement)`); re-read on a theme change. */
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

/** ECharts renders a tooltip formatter's string as HTML: names from the API are escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** `aria-label` of the canvas: «<title>: <name> — <value>; …» (README «График»). */
export function chartSummary(title: string, bars: readonly Bar[]): string {
  return `${title}: ${bars.map((b) => `${b.label} — ${b.display}`).join('; ')}`;
}

export interface BarLayout {
  /** Canvas width, px: the category labels get at most ~40% of it. */
  width: number;
  reducedMotion: boolean;
  /** Integer values (counts): the axis never shows fractional ticks. */
  integer?: boolean;
  /** Axis tick text (`12%`). */
  axisFormat?: (value: number) => string;
}

/** Longest bar thickness (dataviz: ≤ 24 px, never filling the band). */
export const BAR_MAX_WIDTH = 20;

export function barOptions(bars: readonly Bar[], c: ChartColors, layout: BarLayout): Record<string, unknown> {
  const labelWidth = Math.max(72, Math.min(180, Math.round(layout.width * 0.4)));
  const text = { fontFamily: c.font, fontSize: 12 };
  return {
    animation: !layout.reducedMotion,
    animationDuration: 150,
    animationDurationUpdate: 150,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    aria: { enabled: false },
    grid: { left: 8, right: 56, top: 4, bottom: 4, containLabel: true },
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
      // Value first (strong), the name second — every value is also at the tip and in the table.
      formatter: (params: { dataIndex: number }[]) => {
        const bar = bars[params[0]?.dataIndex ?? -1];
        return bar ? `<strong>${escapeHtml(bar.display)}</strong><br>${escapeHtml(bar.label)}` : '';
      },
    },
    xAxis: {
      type: 'value',
      ...(layout.integer ? { minInterval: 1 } : {}),
      // Few ticks on a narrow canvas; ticks that would still touch are dropped (every value is also at its bar).
      splitNumber: layout.width < 480 ? 3 : 5,
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
      axisLabel: { ...text, color: c.axis, width: labelWidth, overflow: 'truncate', ellipsis: '…' },
    },
    series: [
      {
        type: 'bar',
        data: bars.map((b) => b.value),
        barMaxWidth: BAR_MAX_WIDTH,
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
