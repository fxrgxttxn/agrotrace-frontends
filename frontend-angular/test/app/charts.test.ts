import { describe, expect, it } from 'vitest';
import type { Json } from '../msw/fromContract';
import {
  BAR_MAX_WIDTH,
  barOptions,
  chartSummary,
  escapeHtml,
  readChartColors,
  type Bar,
} from '../../src/charts/bars';

const TOKENS: Record<string, string> = {
  '--c-field': '#4F6B3A',
  '--c-field-hover': '#435B31',
  '--c-line': '#D5D3C2',
  '--c-ink-muted': '#75685A',
  '--c-ink': '#33291F',
  '--c-surface': '#F9F8F2',
  '--c-surface-sunk': '#E3E4D8',
  '--font-body': 'Onest, sans-serif',
};
const colors = readChartColors((n) => TOKENS[n] ?? '');
const bars: Bar[] = [
  { key: 'a', label: 'Пшеница озимая', value: 12.5, display: '12,50%' },
  { key: 'b', label: '<img src=x onerror=alert(1)>', value: 0, display: '0,00%' },
];
type Opt = Json;
const opts = (layout = { width: 600, reducedMotion: false }) => barOptions(bars, colors, layout) as Opt;

describe('bar chart options', () => {
  it('one series in --c-field; bars at most 20 px with the data end rounded, the baseline square', () => {
    const o = opts();
    expect(o.series).toHaveLength(1);
    const s = o.series[0];
    expect(s.itemStyle.color).toBe('#4F6B3A');
    expect(s.barMaxWidth).toBe(BAR_MAX_WIDTH);
    expect(BAR_MAX_WIDTH).toBeLessThanOrEqual(24);
    expect(s.itemStyle.borderRadius).toEqual([0, 4, 4, 0]);
    expect(s.data).toEqual([12.5, 0]);
  });

  it('grid solid 1 px in --c-line; axis text muted; value labels in ink, not the series colour', () => {
    const o = opts();
    expect(o.xAxis.splitLine.lineStyle).toEqual({ color: '#D5D3C2', width: 1, type: 'solid' });
    expect(o.xAxis.axisLabel.color).toBe('#75685A');
    expect(o.yAxis.axisLabel.color).toBe('#75685A');
    expect(o.series[0].label.color).toBe('#33291F');
    expect(o.series[0].label.formatter({ dataIndex: 0 })).toBe('12,50%');
    expect(o.yAxis.inverse).toBe(true);
    expect(o.yAxis.data).toEqual(['Пшеница озимая', '<img src=x onerror=alert(1)>']);
  });

  it('the tooltip covers the whole band, leads with the value and escapes names', () => {
    const o = opts();
    expect(o.tooltip.trigger).toBe('axis');
    expect(o.tooltip.axisPointer.type).toBe('shadow');
    expect(o.tooltip.className).toBe('at-chart__tooltip');
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toBe('<strong>12,50%</strong><br>Пшеница озимая');
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).toBe(
      '<strong>0,00%</strong><br>&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(escapeHtml(`a&"'`)).toBe('a&amp;&quot;&#39;');
  });

  it('motion only when allowed (150 ms ease-out); names left of the axis when wide, above the bars below 480 px', () => {
    expect(opts().animation).toBe(true);
    expect(opts().animationDuration).toBe(150);
    expect(opts({ width: 320, reducedMotion: true }).animation).toBe(false);
    expect(opts({ width: 1200, reducedMotion: false }).yAxis.axisLabel.width).toBe(240);
    expect(opts({ width: 400 * 1.2, reducedMotion: false }).yAxis.axisLabel.inside).toBeUndefined();
    const narrow = opts({ width: 320, reducedMotion: true });
    expect(narrow.yAxis.axisLabel).toMatchObject({
      inside: true,
      align: 'left',
      verticalAlign: 'bottom',
      width: 256,
    });
    expect(narrow.series[0].barMaxWidth).toBe(12);
    expect(narrow.grid.left).toBe(12);
    expect(opts({ width: 300, reducedMotion: false }).xAxis.splitNumber).toBe(3);
    expect(opts().xAxis.splitNumber).toBe(5);
    expect(opts().xAxis.axisLabel.hideOverlap).toBe(true);
  });

  it('summary for the canvas aria-label', () => {
    expect(chartSummary('Доля брака', bars.slice(0, 1))).toBe('Доля брака: Пшеница озимая — 12,50%');
  });
});
