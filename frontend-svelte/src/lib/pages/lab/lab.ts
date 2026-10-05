import type { Schemas } from '@agrotrace/api-client';
import { concludeLabTest } from '@agrotrace/domain';
import { formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
import { ApiProblem } from '@agrotrace/api-client';
import { LOCALE, t } from '../../app/i18n';
import { ALL, type ListSpec } from '../../app/listState.svelte';

export type LabTest = Schemas['LabTest'];
export type LabListItem = Schemas['LabTestListItem'];
export type LabStatus = Schemas['LabTestStatus'];
export type LabReason = Schemas['LabTestReason'];
export type Conclusion = Schemas['LabConclusion'];
export type Norm = Schemas['LabNorm'];
export type LabResult = Schemas['LabResult'];

export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';
export const STACK = 'display: grid; gap: var(--sp-4)';
export const STATUSES: readonly LabStatus[] = ['QUEUED', 'SAMPLED', 'ESCALATED', 'DONE', 'CANCELLED'];
export const REASONS: readonly LabReason[] = ['RISK', 'PLANNED', 'COMPLAINT', 'INSPECTOR'];
export const SEVERAL = '__several';
export const ACTIVE: readonly LabStatus[] = ['QUEUED', 'SAMPLED', 'ESCALATED'];
export const PROTOCOL_MAX_BYTES = 10485760;

export const SPEC: ListSpec = {
  sort: ['dueAt', 'createdAt', 'completedAt'],
  enums: {
    status: [...STATUSES, ALL],
    reason: REASONS,
    conclusion: ['PASS', 'FAIL'],
    overdue: ['true', 'false'],
  },
  dates: ['from', 'to'],
  texts: ['q'],
};

export const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

export function indicatorText(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return formatDecimal(trimmed, LOCALE);
}

export function decimalOf(text: string): string | null {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1]!;
}
const DECIMAL = /^\d{1,8}(\.\d{1,6})?$/;
export const validDecimal = (text: string) => {
  const d = decimalOf(text);
  return d !== null && DECIMAL.test(d) ? d : null;
};

export function exceeds(norm: Norm, text: string): boolean | null {
  const value = validDecimal(text);
  if (value === null) return null;
  const r = concludeLabTest({ results: [{ indicatorId: norm.indicatorId, value, maxValue: norm.maxValue }] });
  return 'error' in r ? null : r.conclusion === 'FAIL';
}

export function previewConclusion(norms: readonly Norm[], values: Record<string, string>): Conclusion | null {
  const typed = norms.flatMap((n) => {
    const value = validDecimal(values[n.indicatorId] ?? '');
    return value === null ? [] : [{ indicatorId: n.indicatorId, value, maxValue: n.maxValue }];
  });
  const r = concludeLabTest({ results: typed });
  if ('error' in r) return null;
  if (r.conclusion === 'FAIL') return 'FAIL';
  return typed.length === norms.length ? 'PASS' : null;
}

export const normText = (maxValue: string, unit: string) =>
  t('lab.normValue', { value: indicatorText(maxValue), unit });

export const isNormsMismatch = (e: unknown) =>
  e instanceof ApiProblem &&
  e.code === 'VALIDATION' &&
  Boolean(e.errors?.results?.includes('validation.results.mismatch'));

export interface LabProblems {
  describe: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
  fail: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
  alert: { show: (text: string, tone?: 'danger' | 'attention') => void; clear: () => void };
}
