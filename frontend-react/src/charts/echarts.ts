import { init, use as register } from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { barOptions, readChartColors, type Bar } from './bars';

register([BarChart, GridComponent, TooltipComponent, SVGRenderer]);

export interface ChartView {
  destroy: () => void;
}

export function mountBars(
  container: HTMLElement,
  bars: readonly Bar[],
  o: { integer?: boolean; axisFormat?: (value: number) => string },
): ChartView {
  const chart = init(container, undefined, { renderer: 'svg' });
  const css = getComputedStyle(document.documentElement);
  const colors = readChartColors((name) => css.getPropertyValue(name).trim());
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const draw = () =>
    chart.setOption(
      barOptions(bars, colors, { width: container.clientWidth, reducedMotion, ...o }) as never,
      true,
    );
  draw();
  let width = container.clientWidth;
  const observer = new ResizeObserver(() => {
    if (container.clientWidth === width) return;
    width = container.clientWidth;
    chart.resize();
    draw();
  });
  observer.observe(container);
  return {
    destroy: () => {
      observer.disconnect();
      chart.dispose();
    },
  };
}
