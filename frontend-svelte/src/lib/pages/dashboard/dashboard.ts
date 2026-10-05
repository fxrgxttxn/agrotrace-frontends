import type { Schemas } from '@agrotrace/api-client';
import { compareCodePoints } from '@agrotrace/domain';
import { formatDecimal } from '@agrotrace/i18n';
import { LOCALE, t } from '../../app/i18n';
import type { ListSpec } from '../../app/listState.svelte';
import type { Bar } from '../../charts/bars';

export type Scope = Schemas['DashboardScope'];
export type Dashboard = Schemas['Dashboard'];
export type Inspector = Schemas['InspectorDashboard'];
export type Org = Schemas['OrgDashboard'];
export type Lab = Schemas['LabDashboard'];
export type Share = Schemas['RejectedShareItem'];
export type Region = Inspector['violationsByRegion'][number];
export type StatusRow = Org['byStatus'][number];

export const SPEC: ListSpec = { sort: [], dates: ['from', 'to'] };
export const METRICS =
  'display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))';
export const CHARTS =
  'display: grid; gap: var(--sp-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); align-items: start';
const REGION_BARS = 10;
const MAX_WINDOW_DAYS = 366;
const DAY_MS = 86_400_000;

export function windowTooLong(from: string, to: string): boolean {
  return Boolean(from && to) && (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_WINDOW_DAYS;
}

export const int = (n: number) => formatDecimal(String(n), LOCALE);

export function scopeOf(roles: readonly string[]): Scope {
  if (roles.includes('INSPECTOR') || roles.includes('ADMIN')) return 'inspector';
  if (roles.includes('LAB')) return 'lab';
  return 'org';
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
