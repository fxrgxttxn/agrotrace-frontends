import { enumLabel } from './enum-labels.js';
import { formatDate, formatDecimal, type Locale } from './format.js';
import { formatLocalDateTime } from './local-date.js';
import type { T } from './problem.js';

// The audit diff in words (polish P1, all frontends): the contract writes `diff` as «API field name (camelCase) →
// [before, after]» with values in the API format (instants ISO 8601 UTC, dates YYYY-MM-DD). The «Изменения» dialog
// shows each field by its label (`audit.fields.<name>`, the API name under it) and each value readable.

/** Label of a diff field, e.g. `massKg` → «Масса, кг»; a field without a label stays as the API named it. */
export function auditFieldLabel(t: T, field: string): string {
  const key = `audit.fields.${field}`;
  const label = t(key);
  return label === key ? field : label;
}

/** Label of an audited action: an operationId (`audit.actions.<id>`), a scheduled job `system.<job>`
 * (`audit.jobs.<job>`) or `seed`; an unknown action stays as it is. */
export function auditActionLabel(t: T, action: string): string {
  const key = action.startsWith('system.') ? `audit.jobs.${action.slice(7)}` : `audit.actions.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

/** The status enum of each audited entity type (its `status` field). */
const STATUS_OF: Record<string, string> = {
  organization: 'OrganizationStatus',
  user: 'UserStatus',
  batch: 'BatchStatus',
  waybill: 'WaybillStatus',
  labTest: 'LabTestStatus',
  recall: 'RecallStatus',
  recallTask: 'RecallTaskStatus',
  complaint: 'ComplaintStatus',
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+\.\d+$/;

/** A wire decimal in the locale: a mass (`…Kg`) keeps its three digits, other values lose trailing zeros. */
function decimal(v: string, field: string | undefined, locale: Locale): string {
  if (field?.endsWith('Kg')) return formatDecimal(v, locale);
  return formatDecimal(v.replace(/\.?0+$/, ''), locale);
}

export interface AuditValueContext {
  field: string;
  entityType: string;
  /** The name of a referenced record (`productId`, `regionCode`…) when the screen knows it; else the id is shown. */
  resolve?: (field: string, value: string) => string | undefined;
}

/** A diff value as a person reads it: null — «—», an instant in the viewer's time zone, a date ДД.ММ.ГГГГ, yes / no,
 * a status by the entity's status enum, a referenced record by its name (`resolve`), decimals in the locale (masses
 * with their three digits, others without trailing zeros); other texts and integers as they are (secrets stay «***»),
 * objects and lists as JSON. */
export function auditValue(t: T, v: unknown, locale: Locale, where?: AuditValueContext): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return t(v ? 'audit.yes' : 'audit.no');
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : decimal(String(v), where?.field, locale);
  if (typeof v === 'string') {
    if (INSTANT.test(v)) return formatLocalDateTime(v, locale);
    if (DATE.test(v)) return formatDate(v, locale);
    if (DECIMAL.test(v)) return decimal(v, where?.field, locale);
    const name = where?.resolve?.(where.field, v);
    if (name) return name;
    const statuses = where?.field === 'status' ? STATUS_OF[where.entityType] : undefined;
    return statuses ? enumLabel(t, statuses, v) : v;
  }
  return JSON.stringify(v);
}
