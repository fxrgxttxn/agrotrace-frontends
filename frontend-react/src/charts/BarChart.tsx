import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '../app/i18n';
import { Table, type Column } from '../ui';
import { useThemeVersion } from '../ui/fullscreen';
import { chartSummary, type Bar } from './bars';
import type { ChartView } from './echarts';

// `at-chart` (README «График»): the ECharts canvas (`role="img"` with a summary of every bar) and, under it, the same
// values as a table in a collapsed `details` — tooltips enhance, the table is the keyboard and screen-reader view.
// ECharts is its own lazy chunk (the dashboard page does not carry it); the chart is drawn again when the theme
// changes (token values are read with getComputedStyle).

/** One request for the chart chunk however many charts mount together (a failure lets the next mount try again). */
let loading: Promise<typeof import('./echarts')> | null = null;
function loadCharts() {
  loading ??= import('./echarts').catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

export interface BarChartProps<T> {
  /** The card title: the canvas summary starts with it, the table caption is it. */
  title: string;
  bars: Bar[];
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** A refetch is under way: the previous render stays, dimmed. */
  busy?: boolean;
  integer?: boolean;
  axisFormat?: (value: number) => string;
}

export function BarChart<T>({
  title,
  bars,
  columns,
  rows,
  rowKey,
  busy,
  integer,
  axisFormat,
}: BarChartProps<T>) {
  return (
    <div
      className="at-chart"
      aria-busy={busy ? 'true' : undefined}
      style={{ '--at-chart-rows': bars.length } as CSSProperties}
    >
      <ChartCanvas title={title} bars={bars} integer={integer} axisFormat={axisFormat} />
      <details className="at-chart__data">
        <summary className="at-chart__data-toggle">{t('dashboard.table')}</summary>
        <Table cards caption={title} columns={columns} rows={rows} rowKey={rowKey} />
      </details>
    </div>
  );
}

function ChartCanvas({
  title,
  bars,
  integer,
  axisFormat,
}: {
  title: string;
  bars: Bar[];
  integer?: boolean;
  axisFormat?: (value: number) => string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const theme = useThemeVersion();
  const format = useRef(axisFormat);
  format.current = axisFormat;
  // Redrawn only when what is drawn changes (a re-render with equal data keeps the chart).
  const data = JSON.stringify(bars);

  useEffect(() => {
    let cancelled = false;
    let view: ChartView | null = null;
    loadCharts().then(
      ({ mountBars }) => {
        if (cancelled || !el.current) return;
        view = mountBars(el.current, JSON.parse(data) as Bar[], {
          integer,
          axisFormat: format.current && ((v: number) => format.current!(v)),
        });
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [data, integer, theme]);

  if (failed)
    return (
      <div className="at-chart__canvas">
        <p role="alert" style={{ margin: 0, padding: 'var(--sp-4) 0' }}>
          {t('dashboard.chartFailed')}
        </p>
      </div>
    );
  return <div className="at-chart__canvas" role="img" aria-label={chartSummary(title, bars)} ref={el}></div>;
}
