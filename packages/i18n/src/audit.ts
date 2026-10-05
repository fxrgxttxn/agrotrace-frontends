import { enumLabel } from './enum-labels.js';
import { formatDate, formatDecimal, type Locale } from './format.js';
import { formatLocalDateTime } from './local-date.js';
import type { T } from './problem.js';

export function auditFieldLabel(t: T, field: string): string {
  const key = `audit.fields.${field}`;
  const label = t(key);
  return label === key ? field : label;
}

export function auditActionLabel(t: T, action: string): string {
  const key = action.startsWith('system.') ? `audit.jobs.${action.slice(7)}` : `audit.actions.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

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

function decimal(v: string, field: string | undefined, locale: Locale): string {
  if (field?.endsWith('Kg')) return formatDecimal(v, locale);
  return formatDecimal(v.replace(/\.?0+$/, ''), locale);
}

export interface AuditValueContext {
  field: string;
  entityType: string;
  resolve?: (field: string, value: string) => string | undefined;
}

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
