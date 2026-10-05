<script lang="ts">
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel, formatDate, formatDecimal, formatPercent } from '@agrotrace/i18n';
  import { call, errorText } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import DateFilter from '../../app/DateFilter.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listParams } from '../../app/listState.svelte';
  import { session } from '../../app/session.svelte';
  import BarChart from '../../charts/BarChart.svelte';
  import type { Bar } from '../../charts/bars';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Metric from '../../ui/Metric.svelte';
  import Page from '../../ui/Page.svelte';
  import PageToolbar from '../../ui/PageToolbar.svelte';
  import type { Column } from '../../ui/table';
  import {
    CHARTS,
    int,
    METRICS,
    regionBars,
    scopeOf,
    SPEC,
    windowTooLong,
    type Dashboard,
    type Region,
    type Share,
    type StatusRow,
  } from './dashboard';

  const scope = $derived(scopeOf(session.me?.roles ?? []));
  const list = listParams(() => '/', SPEC);
  const from = $derived(list.get('from'));
  const to = $derived(list.get('to'));
  const tooLong = $derived(windowTooLong(from, to));

  const dashboard = query(
    () => (tooLong ? null : ['dashboard', scope, from, to]),
    ([, s, f, until]) =>
      call<Dashboard>(
        session.api.GET('/analytics/dashboard', {
          params: {
            query: {
              scope: s as Dashboard['scope'],
              ...(f ? { from: String(f) } : {}),
              ...(until ? { to: String(until) } : {}),
            },
          },
        }),
      ),
    { failed: 'dashboard.failed' },
  );
  const data = $derived(dashboard.data);
  const period = $derived(data?.period);
  const busy = $derived(dashboard.fetching);
  const forbidden = $derived(!data && dashboard.error instanceof ApiProblem && dashboard.error.status === 403);

  const shareColumns = (nameHeader: string): Column<Share>[] => [
    { key: 'name', header: nameHeader, primary: true, text: (s) => s.name },
    { key: 'tested', header: t('dashboard.tested'), numeric: true, text: (s) => int(s.tested) },
    { key: 'failed', header: t('dashboard.failedCount'), numeric: true, text: (s) => int(s.failed) },
    { key: 'share', header: t('dashboard.share'), numeric: true, text: (s) => formatDecimal(s.share, LOCALE) },
  ];
  const shareBars = (items: Share[]): Bar[] =>
    items.map((s) => ({ key: s.key, label: s.name, value: Number(s.share), display: formatPercent(s.share, LOCALE) }));
  const percentAxis = (v: number) => `${formatDecimal(String(v), LOCALE)}%`;
  const regionColumns: Column<Region>[] = [
    { key: 'region', header: t('dashboard.region'), primary: true, text: (r) => r.name },
    { key: 'count', header: t('dashboard.count'), numeric: true, text: (r) => int(r.count) },
  ];
  const statusLabel = (s: StatusRow) => enumLabel(t, 'BatchStatus', s.status);
  const statusColumns: Column<StatusRow>[] = [
    { key: 'status', header: t('dashboard.status'), primary: true, text: statusLabel },
    { key: 'count', header: t('dashboard.batchCount'), numeric: true, text: (s) => int(s.count) },
  ];
</script>

{#snippet hours(label: string, value: string | null)}
  {#if value === null}
    <Metric {label} value="—" />
  {:else}
    <Metric {label} value={formatDecimal(value, LOCALE)} unit={t('unit.hours')} />
  {/if}
{/snippet}

{#snippet noData(text: string)}<p class="at-chart__empty">{text}</p>{/snippet}

{#snippet shareChart(title: string, nameHeader: string, items: Share[])}
  <Card style="min-width: 0">
    <CardHeader {title} />
    <CardBody>
      {#if items.length === 0}
        {@render noData(t('dashboard.noData'))}
      {:else}
        <BarChart
          {title}
          bars={shareBars(items)}
          columns={shareColumns(nameHeader)}
          rows={items}
          rowKey={(s) => s.key}
          axisFormat={percentAxis}
        />
      {/if}
    </CardBody>
  </Card>
{/snippet}

{#snippet note()}{#if period}{formatDate(period.from, LOCALE)} — {formatDate(period.to, LOCALE)}{/if}{/snippet}

{#snippet filters()}
  <DateFilter
    id="dashboard-from"
    label={t('dashboard.from')}
    value={from || period?.from || ''}
    max={to || undefined}
    onchange={(v) => list.set({ from: v })}
  />
  <DateFilter
    id="dashboard-to"
    label={t('dashboard.to')}
    value={to || period?.to || ''}
    min={from || undefined}
    onchange={(v) => list.set({ to: v })}
  />
{/snippet}

<Page title={t('page.dashboard')}>
  <PageToolbar count={[from, to].filter(Boolean).length} note={!tooLong && period ? note : undefined} {filters} />
  {#if tooLong}
    <Card>
      <Empty art="empty-search" text={t('validation.range.tooLong')}>
        {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
      </Empty>
    </Card>
  {:else if forbidden}
    <Card><Empty art="forbidden" text={errorText(dashboard.error)} /></Card>
  {:else if !data && dashboard.failed}
    <AreaFailed
      text={t('dashboard.failed')}
      {busy}
      onretry={() => void userAction(dashboard.refetch)}
      onreset={isBadListQuery(dashboard.error) ? list.reset : undefined}
    />
  {:else if !data}
    <AreaLoading blocks={3} />
  {:else}
    <div
      aria-busy={busy ? 'true' : undefined}
      style="display: grid; gap: var(--sp-5); opacity: {busy ? 0.6 : 1}; transition: opacity var(--dur-fast) var(--ease)"
    >
      {#if data.scope === 'inspector'}
        {@const regions = regionBars(data.violationsByRegion)}
        {@const regionTitle = t('dashboard.byRegion')}
        <div style={METRICS}>
          <Metric label={t('dashboard.batchesTotal')} value={int(data.batchesTotal)} />
          <Metric label={t('dashboard.activeRecalls')} value={int(data.activeRecalls)} />
          {@render hours(t('dashboard.avgRecall'), data.avgRecallHours)}
          <Metric
            label={t('dashboard.violations')}
            value={int(data.violationsByRegion.reduce((s, r) => s + r.count, 0))}
          />
        </div>
        <div style={CHARTS}>
          {@render shareChart(t('dashboard.byProduct'), t('dashboard.product'), data.rejectedShare.byProduct)}
          {@render shareChart(t('dashboard.byFarm'), t('dashboard.farm'), data.rejectedShare.byFarm)}
          <Card style="min-width: 0; grid-column: 1 / -1">
            <CardHeader title={regionTitle} />
            <CardBody>
              {#if regions.bars.length === 0}
                {@render noData(t('dashboard.noViolations'))}
              {:else}
                <BarChart
                  title={regionTitle}
                  bars={regions.bars}
                  columns={regionColumns}
                  rows={regions.rows}
                  rowKey={(r) => r.code}
                  integer
                />
              {/if}
            </CardBody>
          </Card>
        </div>
      {:else if data.scope === 'org'}
        {@const title = t('dashboard.byStatus')}
        <div style={METRICS}>
          <Metric label={t('dashboard.batches')} value={int(data.byStatus.reduce((s, r) => s + r.count, 0))} />
          <Metric label={t('dashboard.labPass')} value={int(data.labResults.pass)} />
          <Metric label={t('dashboard.labFail')} value={int(data.labResults.fail)} />
          <Metric
            label={t('dashboard.openTasks')}
            value={int(data.openTasks)}
            delta={data.overdueTasks > 0 ? t('dashboard.overdueTasks', { count: data.overdueTasks }) : undefined}
          />
        </div>
        <div style={CHARTS}>
          <Card style="min-width: 0">
            <CardHeader {title} />
            <CardBody>
              <BarChart
                {title}
                bars={data.byStatus.map((s) => ({ key: s.status, label: statusLabel(s), value: s.count, display: int(s.count) }))}
                columns={statusColumns}
                rows={data.byStatus}
                rowKey={(s) => s.status}
                integer
              />
            </CardBody>
          </Card>
        </div>
      {:else}
        <div style={METRICS}>
          <Metric label={t('dashboard.queue')} value={int(data.queue)} />
          <Metric label={t('dashboard.overdue')} value={int(data.overdue)} />
          <Metric label={t('dashboard.completed')} value={int(data.completed)} />
          <Metric label={t('dashboard.failedTests')} value={int(data.failed)} />
          {@render hours(t('dashboard.avgTest'), data.avgHours)}
        </div>
      {/if}
    </div>
  {/if}
</Page>
