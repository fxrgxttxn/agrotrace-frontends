import type { Schemas } from '@agrotrace/api-client';
import { concludeLabTest } from '@agrotrace/domain';
import { formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
import { ApiProblem } from '@agrotrace/api-client';
import { LOCALE, t } from '../../app/i18n';
import { ALL, type ListSpec } from '../../app/listState.svelte';

// Laboratory (БП-2, FR-QA-02…05, BR-02): the queue (`/lab/tests`) and the card (`/lab/tests/:id`). The same rules as
// the React app (src/pages/lab.tsx there): the live comparison against the norm is the domain's `concludeLabTest`
// (exact decimals — never floats); what may be done comes from `LabTest.actions`.

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
/** The queue opens on the tests still to do (ruling FM20); every status is the explicit `status=all`. */
export const ACTIVE: readonly LabStatus[] = ['QUEUED', 'SAMPLED', 'ESCALATED'];
/** Contract limit of the report (uploadLabProtocol): ≤ 10 485 760 bytes inclusive, PDF by content. */
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

/** An `IndicatorValue` (`612.000000`) as people read it: trailing zeros dropped, the locale's separators. */
export function indicatorText(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return formatDecimal(trimmed, LOCALE);
}

/** A typed value as a wire decimal (`0,15` → `0.15`); `null` when it is not a plain number (no sign, no exponent). */
export function decimalOf(text: string): string | null {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1]!;
}
/** The contract's `Decimal`: up to 8 integer digits and 6 decimals. */
const DECIMAL = /^\d{1,8}(\.\d{1,6})?$/;
export const validDecimal = (text: string) => {
  const d = decimalOf(text);
  return d !== null && DECIMAL.test(d) ? d : null;
};

/** Live BR-02 of one value against its norm (the domain's comparison); `null` while it is not a number yet. */
export function exceeds(norm: Norm, text: string): boolean | null {
  const value = validDecimal(text);
  if (value === null) return null;
  const r = concludeLabTest({ results: [{ indicatorId: norm.indicatorId, value, maxValue: norm.maxValue }] });
  return 'error' in r ? null : r.conclusion === 'FAIL';
}

/** The conclusion the values would get (BR-02): FAIL as soon as one value is over its norm, PASS once every value is
 * a number within its norm, otherwise not known yet. */
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

/** The indicator set no longer matches the norms (a norm was added or removed meanwhile, ruling FM20). */
export const isNormsMismatch = (e: unknown) =>
  e instanceof ApiProblem &&
  e.code === 'VALIDATION' &&
  Boolean(e.errors?.results?.includes('validation.results.mismatch'));

/** Failures of the card's actions (FM13): the text and tone, re-reading the card when stale. */
export interface LabProblems {
  /** Describes the failure (re-reading when stale) without showing it — a dialog says it (README «Диалог»). */
  describe: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
  /** Describes the failure (re-reading when stale) and shows it as the page message. */
  fail: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
  alert: { show: (text: string, tone?: 'danger' | 'attention') => void; clear: () => void };
}
