import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { compareCodePoints } from '@agrotrace/domain';
import { enumLabel, formatDate, formatDecimal, formatPercent } from '@agrotrace/i18n';
import { call, errorText } from '../app/api';
import { DateFilterComponent } from '../app/date-filter';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, type ListSpec } from '../app/list-state';
import { injectQuery } from '../app/query';
import { SessionService } from '../app/session';
import { PageToolbarComponent, ToolbarFiltersDirective, UI } from '../app/ui';
import { BarChartComponent } from '../charts/bar-chart';
import type { Bar } from '../charts/bars';
import { DASHBOARD_KEY } from './keys';
import { areaLoading, loadFailed } from './lists';

// `/` — the dashboard of the viewer's role (FR-ANL-01…03, README «Дашборд»), the Angular mirror of the React screen
// (pages/home.tsx): the scope comes from the roles (INSPECTOR/ADMIN — inspector, LAB — lab, otherwise org; R51), the
// period is `from`/`to` in the URL (absent — the server's default window, shown in the fields from the answer's
// `period`). Every number is the server's (one snapshot, the contract's formulas); the page lays them out: at-metric
// values and bar charts by the `dataviz` rules (one series, one colour) with a table view each. ECharts is loaded with
// the first chart, not with this page.

type Scope = Schemas['DashboardScope'];
type Dashboard = Schemas['Dashboard'];
type Inspector = Schemas['InspectorDashboard'];
type Org = Schemas['OrgDashboard'];
type Lab = Schemas['LabDashboard'];
type Share = Schemas['RejectedShareItem'];
type Region = Inspector['violationsByRegion'][number];
type StatusRow = Org['byStatus'][number];

const SPEC: ListSpec = { sort: [], dates: ['from', 'to'] };
// Narrow enough for five tiles in one row at 1280 px (the lab dashboard): no orphan tile there.
const METRICS =
  'display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))';
const CHARTS =
  'display: grid; gap: var(--sp-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); align-items: start';
/** Bars of the regions chart before the rest folds into «Другие» (README «Дашборд»). */
const REGION_BARS = 10;
/** Longest window of the contract (`getDashboard`: longer — 400 `validation.range.tooLong`), days inclusive. */
const MAX_WINDOW_DAYS = 366;
const DAY_MS = 86_400_000;

/** A window the server would refuse as too long (both ends given; a single end gets a 30-day window). */
export function windowTooLong(from: string, to: string): boolean {
  return Boolean(from && to) && (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_WINDOW_DAYS;
}

const int = (n: number) => formatDecimal(String(n), LOCALE);

export function scopeOf(roles: readonly string[]): Scope {
  if (roles.includes('INSPECTOR') || roles.includes('ADMIN')) return 'inspector';
  if (roles.includes('LAB')) return 'lab';
  return 'org';
}

/** Regions with violations, most first (then by code); past 10 — nine bars and «Другие» with the sum of the rest. The
 * table lists every region with violations. */
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

const shareBars = (items: readonly Share[]): Bar[] =>
  items.map((s) => ({
    key: s.key,
    label: s.name,
    value: Number(s.share),
    display: formatPercent(s.share, LOCALE),
  }));

/** A metric of hours (`Hours`, two places) as «18,25 ч»; null — «—» without a unit. */
function hoursMetric(label: string, hours: string): string {
  return `@if (${hours} === null) {
          <div class="at-metric" [label]="${label}" [value]="'—'"></div>
        } @else {
          <div class="at-metric" [label]="${label}" [value]="decimal(${hours})" [unit]="t('unit.hours')"></div>
        }`;
}

/** A chart in its card (`wide` — the card takes the whole row: never an orphan beside an empty cell). A grid item may
 * shrink below its content: the table view scrolls inside its own wrap, never the page. */
function chartCard(title: string, body: string, wide = false): string {
  return `<article class="at-card" style="min-width: 0${wide ? '; grid-column: 1 / -1' : ''}">
          <header class="at-card__header" [cardTitle]="${title}"></header>
          <div class="at-card__body">${body}</div>
        </article>`;
}

/** The rejected-share chart of `items` (by product or farm) with its table. */
function shareChart(title: string, nameHeader: string, items: string): string {
  return chartCard(
    title,
    `@if (${items}.length === 0) {
            <p class="at-chart__empty">{{ t('dashboard.noData') }}</p>
          } @else {
            <div class="at-chart" [bars]="shares(${items})" [title]="${title}" [axisFormat]="percentAxis">
              <div class="at-table-wrap" [cards]="true" [caption]="${title}" [rows]="${items}" [rowKey]="shareKey">
                <ng-template [atColumn]="'name'" [header]="${nameHeader}" [primary]="true" let-s>{{ s.name }}</ng-template>
                <ng-template [atColumn]="'tested'" [header]="t('dashboard.tested')" [numeric]="true" let-s>{{ int(s.tested) }}</ng-template>
                <ng-template [atColumn]="'failed'" [header]="t('dashboard.failedCount')" [numeric]="true" let-s>{{ int(s.failed) }}</ng-template>
                <ng-template [atColumn]="'share'" [header]="t('dashboard.share')" [numeric]="true" let-s>{{ decimal(s.share) }}</ng-template>
              </div>
            </div>
          }`,
  );
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI, PageToolbarComponent, ToolbarFiltersDirective, DateFilterComponent, BarChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.dashboard')"></div>
    <div class="at-page__toolbar" [count]="count()" [note]="note()">
      <ng-template atToolbarFilters>
        <div
          class="at-field"
          [dateFilter]="'dashboard-from'"
          [label]="t('dashboard.from')"
          [value]="from() || period()?.from || ''"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'dashboard-to'"
          [label]="t('dashboard.to')"
          [value]="to() || period()?.to || ''"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (tooLong()) {
      <article class="at-card">
        <div class="at-empty" [art]="'empty-search'" [text]="t('validation.range.tooLong')">
          <button class="at-button" [variant]="'primary'" (click)="list.reset()">
            {{ t('filters.reset') }}
          </button>
        </div>
      </article>
    } @else if (!query.data() && forbidden()) {
      <!-- 403: a retry cannot help — the reason, no button -->
      <article class="at-card">
        <div class="at-empty" [art]="'forbidden'" [text]="forbiddenText()"></div>
      </article>
    } @else if (!query.data() && query.failed()) {
      ${loadFailed("t('dashboard.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data()) {
      ${areaLoading(3)}
    } @else {
      <!-- A refetch keeps the previous numbers, dimmed (no skeleton flash, no layout jump). -->
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" [attr.style]="dimmed()">
        @if (inspector(); as d) {
          <div style="${METRICS}">
            <div class="at-metric" [label]="t('dashboard.batchesTotal')" [value]="int(d.batchesTotal)"></div>
            <div
              class="at-metric"
              [label]="t('dashboard.activeRecalls')"
              [value]="int(d.activeRecalls)"
            ></div>
            ${hoursMetric("t('dashboard.avgRecall')", 'd.avgRecallHours')}
            <div class="at-metric" [label]="t('dashboard.violations')" [value]="int(violations(d))"></div>
          </div>
          <div style="${CHARTS}">
            ${shareChart("t('dashboard.byProduct')", "t('dashboard.product')", 'd.rejectedShare.byProduct')}
            ${shareChart("t('dashboard.byFarm')", "t('dashboard.farm')", 'd.rejectedShare.byFarm')}
            ${chartCard(
              "t('dashboard.byRegion')",
              `@if (regions().bars.length === 0) {
                <p class="at-chart__empty">{{ t('dashboard.noViolations') }}</p>
              } @else {
                <div class="at-chart" [bars]="regions().bars" [title]="t('dashboard.byRegion')" [integer]="true">
                  <div class="at-table-wrap" [cards]="true" [caption]="t('dashboard.byRegion')" [rows]="regions().rows" [rowKey]="regionKey">
                    <ng-template [atColumn]="'region'" [header]="t('dashboard.region')" [primary]="true" let-r>{{ r.name }}</ng-template>
                    <ng-template [atColumn]="'count'" [header]="t('dashboard.count')" [numeric]="true" let-r>{{ int(r.count) }}</ng-template>
                  </div>
                </div>
              }`,
              true,
            )}
          </div>
        }
        @if (org(); as d) {
          <div style="${METRICS}">
            <div class="at-metric" [label]="t('dashboard.batches')" [value]="int(statusTotal(d))"></div>
            <div class="at-metric" [label]="t('dashboard.labPass')" [value]="int(d.labResults.pass)"></div>
            <div class="at-metric" [label]="t('dashboard.labFail')" [value]="int(d.labResults.fail)"></div>
            <div
              class="at-metric"
              [label]="t('dashboard.openTasks')"
              [value]="int(d.openTasks)"
              [delta]="
                d.overdueTasks > 0 ? t('dashboard.overdueTasks', { count: d.overdueTasks }) : undefined
              "
            ></div>
          </div>
          <div style="${CHARTS}">
            ${chartCard(
              "t('dashboard.byStatus')",
              `<div class="at-chart" [bars]="statusBars(d)" [title]="t('dashboard.byStatus')" [integer]="true">
                <div class="at-table-wrap" [cards]="true" [caption]="t('dashboard.byStatus')" [rows]="d.byStatus" [rowKey]="statusKey">
                  <ng-template [atColumn]="'status'" [header]="t('dashboard.status')" [primary]="true" let-s>{{ statusLabel(s) }}</ng-template>
                  <ng-template [atColumn]="'count'" [header]="t('dashboard.batchCount')" [numeric]="true" let-s>{{ int(s.count) }}</ng-template>
                </div>
              </div>`,
            )}
          </div>
        }
        @if (lab(); as d) {
          <div style="${METRICS}">
            <div class="at-metric" [label]="t('dashboard.queue')" [value]="int(d.queue)"></div>
            <div class="at-metric" [label]="t('dashboard.overdue')" [value]="int(d.overdue)"></div>
            <div class="at-metric" [label]="t('dashboard.completed')" [value]="int(d.completed)"></div>
            <div class="at-metric" [label]="t('dashboard.failedTests')" [value]="int(d.failed)"></div>
            ${hoursMetric("t('dashboard.avgTest')", 'd.avgHours')}
          </div>
        }
      </div>
    }`,
})
export class DashboardPage {
  protected readonly t = t;
  protected readonly int = int;
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly shares = shareBars;
  protected readonly percentAxis = (v: number) => `${formatDecimal(String(v), LOCALE)}%`;
  protected readonly shareKey = (s: Share) => s.key;
  protected readonly regionKey = (r: Region) => r.code;
  protected readonly statusKey = (s: StatusRow) => s.status;
  protected readonly statusLabel = (s: StatusRow) => enumLabel(t, 'BatchStatus', s.status);
  protected readonly violations = (d: Inspector) => d.violationsByRegion.reduce((s, r) => s + r.count, 0);
  protected readonly statusTotal = (d: Org) => d.byStatus.reduce((s, r) => s + r.count, 0);
  protected readonly statusBars = (d: Org): Bar[] =>
    d.byStatus.map((s) => ({
      key: s.status,
      label: this.statusLabel(s),
      value: s.count,
      display: int(s.count),
    }));

  private readonly session = inject(SessionService);
  private readonly scope = computed(() => scopeOf(this.session.me()?.roles ?? []));
  protected readonly list = injectListParams('/', SPEC);
  protected readonly from = computed(() => this.list.params().get('from') ?? '');
  protected readonly to = computed(() => this.list.params().get('to') ?? '');
  // Checked before asking (ruling FM20): the contract's own message, and «Сбросить фильтры».
  protected readonly tooLong = computed(() => windowTooLong(this.from(), this.to()));
  protected readonly count = computed(() => [this.from(), this.to()].filter(Boolean).length);

  protected readonly query = injectQuery(
    () => {
      if (this.tooLong()) return null;
      const scope = this.scope();
      const from = this.from();
      const to = this.to();
      return {
        key: `${DASHBOARD_KEY}${JSON.stringify([scope, from, to])}`,
        load: () =>
          call<Dashboard>(
            this.session.api.GET('/analytics/dashboard', {
              params: { query: { scope, ...(from ? { from } : {}), ...(to ? { to } : {}) } },
            }),
          ),
      };
    },
    { failedText: t('dashboard.failed') },
  );
  protected readonly dimmed = computed(
    () =>
      `display: grid; gap: var(--sp-5); opacity: ${this.query.fetching() ? 0.6 : 1}; ` +
      'transition: opacity var(--dur-fast) var(--ease)',
  );
  protected readonly period = computed(() => this.query.data()?.period);
  protected readonly note = computed(() => {
    const p = this.period();
    return !this.tooLong() && p ? `${formatDate(p.from, LOCALE)} — ${formatDate(p.to, LOCALE)}` : undefined;
  });
  protected readonly forbidden = computed(() => {
    const e = this.query.error();
    return e instanceof ApiProblem && e.status === 403;
  });
  protected readonly forbiddenText = computed(() => errorText(this.query.error()));
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));
  protected readonly inspector = computed(() => {
    const d = this.query.data();
    return d?.scope === 'inspector' ? (d as Inspector) : null;
  });
  protected readonly org = computed(() => {
    const d = this.query.data();
    return d?.scope === 'org' ? (d as Org) : null;
  });
  protected readonly lab = computed(() => {
    const d = this.query.data();
    return d?.scope === 'lab' ? (d as Lab) : null;
  });
  protected readonly regions = computed(() => regionBars(this.inspector()?.violationsByRegion ?? []));
}
