import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '../app/i18n';
import { Button, Table, type Column } from '../ui';
import { useThemeVersion } from '../ui/fullscreen';
import { afterChunkFailure, here } from '../reload';
import { chartSummary, type Bar } from './bars';
import type { ChartView } from './echarts';

let loading: Promise<typeof import('./echarts')> | null = null;
function loadCharts() {
  loading ??= import('./echarts');
  return loading;
}

type Failure = 'chunk' | 'draw';

export interface BarChartProps<T> {
  title: string;
  bars: Bar[];
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
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
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  if (failure)
    return (
      <div className="at-chart__canvas">
        <div className="at-chart__failed">
          <p role="alert" style={{ margin: 0 }}>
            {t('dashboard.chartFailed')}
          </p>
          <Button
            variant="secondary"
            size="s"
            onClick={() => {
              if (failure === 'chunk') {
                afterChunkFailure(here());
                return;
              }
              setFailure(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t('action.retry')}
          </Button>
        </div>
      </div>
    );
  return (
    <ChartMount
      key={attempt}
      title={title}
      bars={bars}
      integer={integer}
      axisFormat={axisFormat}
      onFail={setFailure}
    />
  );
}

function ChartMount({
  title,
  bars,
  integer,
  axisFormat,
  onFail,
}: {
  title: string;
  bars: Bar[];
  integer?: boolean;
  axisFormat?: (value: number) => string;
  onFail: (f: Failure) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const theme = useThemeVersion();
  const format = useRef(axisFormat);
  format.current = axisFormat;
  const fail = useRef(onFail);
  fail.current = onFail;
  const data = JSON.stringify(bars);

  useEffect(() => {
    let cancelled = false;
    let view: ChartView | null = null;
    loadCharts().then(
      ({ mountBars }) => {
        if (cancelled || !el.current) return;
        try {
          view = mountBars(el.current, JSON.parse(data) as Bar[], {
            integer,
            axisFormat: format.current && ((v: number) => format.current!(v)),
          });
        } catch {
          fail.current('draw');
        }
      },
      () => !cancelled && fail.current('chunk'),
    );
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [data, integer, theme]);

  return <div className="at-chart__canvas" role="img" aria-label={chartSummary(title, bars)} ref={el}></div>;
}
