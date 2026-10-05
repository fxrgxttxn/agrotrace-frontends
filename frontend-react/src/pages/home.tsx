import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { compareCodePoints } from '@agrotrace/domain';
import { enumLabel, formatDate, formatDecimal, formatPercent } from '@agrotrace/i18n';
import { call, errorText } from '../app/api';
import { DateFilter } from '../app/DateFilter';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, useListParams, type ListSpec } from '../app/listState';
import { useMe, useSession } from '../app/session';
import { BarChart } from '../charts/BarChart';
import type { Bar } from '../charts/bars';
import {
  AreaLoading,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  LoadFailed,
  Metric,
  Page,
  PageToolbar,
  type Column,
} from '../ui';

type Scope = Schemas['DashboardScope'];
type Dashboard = Schemas['Dashboard'];
type Inspector = Schemas['InspectorDashboard'];
type Org = Schemas['OrgDashboard'];
type Lab = Schemas['LabDashboard'];
type Share = Schemas['RejectedShareItem'];
type Region = Inspector['violationsByRegion'][number];
type StatusRow = Org['byStatus'][number];

const SPEC: ListSpec = { sort: [], dates: ['from', 'to'] };
const METRICS = {
  display: 'grid',
  gap: 'var(--sp-4)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))',
} as const;
const CHARTS = {
  display: 'grid',
  gap: 'var(--sp-5)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 28rem), 1fr))',
  alignItems: 'start',
} as const;
const REGION_BARS = 10;
const MAX_WINDOW_DAYS = 366;
const DAY_MS = 86_400_000;

export function windowTooLong(from: string, to: string): boolean {
  return Boolean(from && to) && (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_WINDOW_DAYS;
}

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const int = (n: number) => formatDecimal(String(n), LOCALE);

export function scopeOf(roles: readonly string[]): Scope {
  if (roles.includes('INSPECTOR') || roles.includes('ADMIN')) return 'inspector';
  if (roles.includes('LAB')) return 'lab';
  return 'org';
}

export function DashboardPage() {
  const { api } = useSession();
  const me = useMe();
  const scope = scopeOf(me.roles);
  const list = useListParams('/', SPEC);
  const from = list.get('from');
  const to = list.get('to');
  const tooLong = windowTooLong(from, to);

  const query = useQuery({
    enabled: !tooLong,
    queryKey: ['dashboard', scope, { from, to }],
    meta: { failed: 'dashboard.failed' },
    queryFn: () =>
      call<Dashboard>(
        api.GET('/analytics/dashboard', {
          params: { query: { scope, ...(from ? { from } : {}), ...(to ? { to } : {}) } },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const data = query.data;
  const period = data?.period;
  const busy = query.isFetching;

  const content = () => {
    if (tooLong)
      return (
        <Card>
          <Empty
            art="empty-search"
            text={t('validation.range.tooLong')}
            action={
              <Button variant="primary" onClick={list.reset}>
                {t('filters.reset')}
              </Button>
            }
          />
        </Card>
      );
    if (!data && query.error instanceof ApiProblem && query.error.status === 403)
      return (
        <Card>
          <Empty art="forbidden" text={errorText(query.error)} />
        </Card>
      );
    if (!data && query.isError)
      return (
        <LoadFailed
          text={t('dashboard.failed')}
          busy={busy}
          onRetry={() => void query.refetch()}
          onReset={isBadListQuery(query.error) ? list.reset : undefined}
        />
      );
    if (!data) return <AreaLoading blocks={3} />;
    return (
      <div
        aria-busy={busy ? 'true' : undefined}
        style={{
          display: 'grid',
          gap: 'var(--sp-5)',
          opacity: busy ? 0.6 : 1,
          transition: 'opacity var(--dur-fast) var(--ease)',
        }}
      >
        {data.scope === 'inspector' && <InspectorView data={data} />}
        {data.scope === 'org' && <OrgView data={data} />}
        {data.scope === 'lab' && <LabView data={data} />}
      </div>
    );
  };

  return (
    <Page title={t('page.dashboard')}>
      <PageToolbar
        count={[from, to].filter(Boolean).length}
        note={!tooLong && period && `${formatDate(period.from, LOCALE)} — ${formatDate(period.to, LOCALE)}`}
        filters={
          <>
            <DateFilter
              id="dashboard-from"
              label={t('dashboard.from')}
              value={from || period?.from || ''}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="dashboard-to"
              label={t('dashboard.to')}
              value={to || period?.to || ''}
              min={from || undefined}
              onChange={(v) => list.set({ to: v })}
            />
          </>
        }
      />
      {content()}
    </Page>
  );
}

function HoursMetric({ label, hours }: { label: string; hours: string | null }) {
  return hours === null ? (
    <Metric label={label} value="—" />
  ) : (
    <Metric label={label} value={formatDecimal(hours, LOCALE)} unit={t('unit.hours')} />
  );
}

function ChartCard({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <Card style={{ minWidth: 0, ...(wide ? { gridColumn: '1 / -1' } : {}) }}>
      <CardHeader title={title} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function NoData({ text }: { text: string }) {
  return <p className="at-chart__empty">{text}</p>;
}

function ShareChart({ title, nameHeader, items }: { title: string; nameHeader: string; items: Share[] }) {
  if (items.length === 0)
    return (
      <ChartCard title={title}>
        <NoData text={t('dashboard.noData')} />
      </ChartCard>
    );
  const bars: Bar[] = items.map((s) => ({
    key: s.key,
    label: s.name,
    value: Number(s.share),
    display: formatPercent(s.share, LOCALE),
  }));
  const columns: Column<Share>[] = [
    { key: 'name', header: nameHeader, primary: true, cell: (s) => s.name },
    { key: 'tested', header: t('dashboard.tested'), numeric: true, cell: (s) => int(s.tested) },
    { key: 'failed', header: t('dashboard.failedCount'), numeric: true, cell: (s) => int(s.failed) },
    {
      key: 'share',
      header: t('dashboard.share'),
      numeric: true,
      cell: (s) => formatDecimal(s.share, LOCALE),
    },
  ];
  return (
    <ChartCard title={title}>
      <BarChart
        title={title}
        bars={bars}
        columns={columns}
        rows={items}
        rowKey={(s) => s.key}
        axisFormat={(v) => `${formatDecimal(String(v), LOCALE)}%`}
      />
    </ChartCard>
  );
}

export function regionBars(regions: readonly Region[]): { bars: Bar[]; rows: Region[] } {
  const rows = regions
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || compareCodePoints(a.code, b.code));
  const head = rows.length > REGION_BARS ? rows.slice(0, REGION_BARS - 1) : rows;
  const rest = rows.slice(head.length).reduce((s, r) => s + r.count, 0);
  const bars: Bar[] = head.map((r) => ({
    key: r.code,
    label: r.name,
    value: r.count,
    display: int(r.count),
  }));
  if (rest > 0) bars.push({ key: 'other', label: t('dashboard.other'), value: rest, display: int(rest) });
  return { bars, rows };
}

function InspectorView({ data }: { data: Inspector }) {
  const violations = data.violationsByRegion.reduce((s, r) => s + r.count, 0);
  const regions = regionBars(data.violationsByRegion);
  const regionTitle = t('dashboard.byRegion');
  const regionColumns: Column<Region>[] = [
    { key: 'region', header: t('dashboard.region'), primary: true, cell: (r) => r.name },
    { key: 'count', header: t('dashboard.count'), numeric: true, cell: (r) => int(r.count) },
  ];
  return (
    <>
      <div style={METRICS}>
        <Metric label={t('dashboard.batchesTotal')} value={int(data.batchesTotal)} />
        <Metric label={t('dashboard.activeRecalls')} value={int(data.activeRecalls)} />
        <HoursMetric label={t('dashboard.avgRecall')} hours={data.avgRecallHours} />
        <Metric label={t('dashboard.violations')} value={int(violations)} />
      </div>
      <div style={CHARTS}>
        <ShareChart
          title={t('dashboard.byProduct')}
          nameHeader={t('dashboard.product')}
          items={data.rejectedShare.byProduct}
        />
        <ShareChart
          title={t('dashboard.byFarm')}
          nameHeader={t('dashboard.farm')}
          items={data.rejectedShare.byFarm}
        />
        <ChartCard title={regionTitle} wide>
          {regions.bars.length === 0 ? (
            <NoData text={t('dashboard.noViolations')} />
          ) : (
            <BarChart
              title={regionTitle}
              bars={regions.bars}
              columns={regionColumns}
              rows={regions.rows}
              rowKey={(r) => r.code}
              integer
            />
          )}
        </ChartCard>
      </div>
    </>
  );
}

function OrgView({ data }: { data: Org }) {
  const total = data.byStatus.reduce((s, r) => s + r.count, 0);
  const title = t('dashboard.byStatus');
  const label = (s: StatusRow) => enumLabel(t, 'BatchStatus', s.status);
  const columns: Column<StatusRow>[] = [
    { key: 'status', header: t('dashboard.status'), primary: true, cell: label },
    { key: 'count', header: t('dashboard.batchCount'), numeric: true, cell: (s) => int(s.count) },
  ];
  return (
    <>
      <div style={METRICS}>
        <Metric label={t('dashboard.batches')} value={int(total)} />
        <Metric label={t('dashboard.labPass')} value={int(data.labResults.pass)} />
        <Metric label={t('dashboard.labFail')} value={int(data.labResults.fail)} />
        <Metric
          label={t('dashboard.openTasks')}
          value={int(data.openTasks)}
          delta={
            data.overdueTasks > 0 ? t('dashboard.overdueTasks', { count: data.overdueTasks }) : undefined
          }
        />
      </div>
      <div style={CHARTS}>
        <ChartCard title={title}>
          <BarChart
            title={title}
            bars={data.byStatus.map((s) => ({
              key: s.status,
              label: label(s),
              value: s.count,
              display: int(s.count),
            }))}
            columns={columns}
            rows={data.byStatus}
            rowKey={(s) => s.status}
            integer
          />
        </ChartCard>
      </div>
    </>
  );
}

function LabView({ data }: { data: Lab }) {
  return (
    <div style={METRICS}>
      <Metric label={t('dashboard.queue')} value={int(data.queue)} />
      <Metric label={t('dashboard.overdue')} value={int(data.overdue)} />
      <Metric label={t('dashboard.completed')} value={int(data.completed)} />
      <Metric label={t('dashboard.failedTests')} value={int(data.failed)} />
      <HoursMetric label={t('dashboard.avgTest')} hours={data.avgHours} />
    </div>
  );
}
