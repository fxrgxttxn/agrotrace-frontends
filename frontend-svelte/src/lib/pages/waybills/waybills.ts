import { z } from 'zod';
import type { Schemas } from '@agrotrace/api-client';
import { checkDiscrepancy, compareDecimalStrings, gramsToKg, kgToGrams } from '@agrotrace/domain';
import { formatPercent } from '@agrotrace/i18n';
import { WaybillAcceptSchema, WaybillCreateSchema } from '@agrotrace/validation';
import { normalizeDecimal } from '../../app/forms.svelte';
import { LOCALE, t } from '../../app/i18n';
import type { ListSpec } from '../../app/listState.svelte';
import type { Tone } from '../../ui/display';

export type Waybill = Schemas['Waybill'];
export type WaybillStatus = Schemas['WaybillStatus'];
export type BatchItem = Schemas['BatchListItem'];
export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';
export const WAYBILL_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
export const SEVERAL = '__several';

export const WAYBILL_TONE: Record<WaybillStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'move',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

export const PARTICIPANT_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES, direction: ['incoming', 'outgoing'] },
  dates: ['from', 'to'],
  texts: ['q'],
};
export const OVERSEER_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES },
  uuids: ['counterpartyOrgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};

export function totalKg(masses: string[]): string {
  return gramsToKg(masses.reduce((s, m) => s + kgToGrams(m), 0n));
}

export const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

export function discrepancyOf(
  declaredKg: string,
  actualText: string,
): { percent: string; actRequired: boolean } | null {
  const actualKg = normalizeDecimal(actualText, 3);
  if (!/^\d{1,9}\.\d{3}$/.test(actualKg)) return null;
  const r = checkDiscrepancy({ declaredKg, actualKg });
  return 'error' in r ? null : r;
}

export function discrepancyText(d: { percent: string; actRequired: boolean }): string {
  return d.actRequired && compareDecimalStrings(d.percent, '2.00') <= 0
    ? t('waybills.overLimit')
    : formatPercent(d.percent, LOCALE);
}

export interface WaybillNewValues extends Record<string, unknown> {
  receiverOrgId: string;
  picked: string[];
  mass: Record<string, string>;
}

export function waybillNewSchema(batches: BatchItem[]) {
  const byId = new Map(batches.map((b) => [b.id, b]));
  return z.custom<WaybillNewValues>().transform((values, ctx) => {
    const marked = new Set<string>();
    const mark = (path: string, message: string) => {
      if (marked.has(path)) return;
      marked.add(path);
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (!values.receiverOrgId) mark('receiverOrgId', 'validation.required');
    const items = values.picked.map((id) => ({
      batchId: id,
      massDeclaredKg: normalizeDecimal(values.mass[id] ?? '', 3),
    }));
    if (items.length === 0) mark('picked', 'waybills.chooseItems');
    for (const item of items)
      if ((values.mass[item.batchId] ?? '').trim() === '') mark(`mass.${item.batchId}`, 'validation.required');
    const body = { receiverOrgId: values.receiverOrgId || undefined, items };
    const res = WaybillCreateSchema.safeParse(body);
    if (!res.success)
      for (const issue of res.error.issues) {
        const [head, index, leaf] = issue.path;
        if (head === 'items' && typeof index === 'number' && leaf) {
          const id = items[index]?.batchId;
          if (id) mark(`mass.${id}`, String(issue.message));
        } else if (head === 'receiverOrgId') mark('receiverOrgId', String(issue.message));
      }
    for (const item of items) {
      const key = `mass.${item.batchId}`;
      if (marked.has(key)) continue;
      const batch = byId.get(item.batchId);
      if (batch && compareDecimalStrings(item.massDeclaredKg, batch.massKg) > 0)
        mark(key, 'validation.mass.exceedsBatch');
    }
    if (marked.size > 0) return z.NEVER;
    return { receiverOrgId: values.receiverOrgId, items } satisfies Schemas['WaybillCreate'];
  });
}

export interface AcceptValues extends Record<string, unknown> {
  actual: Record<string, string>;
  act: Record<string, string>;
}

export function waybillAcceptSchema(items: Waybill['items']) {
  return z.custom<AcceptValues>().transform((values, ctx) => {
    const marked = new Set<string>();
    const mark = (path: string, message: string) => {
      if (marked.has(path)) return;
      marked.add(path);
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    for (const i of items) {
      const id = i.batch.id;
      if ((values.actual[id] ?? '').trim() === '') mark(`actual.${id}`, 'validation.required');
      const d = discrepancyOf(i.massDeclaredKg, values.actual[id] ?? '');
      if (d?.actRequired && !(values.act[id] ?? '').trim()) mark(`act.${id}`, 'validation.required');
    }
    const built = items.map((i) => {
      const id = i.batch.id;
      const d = discrepancyOf(i.massDeclaredKg, values.actual[id] ?? '');
      const act = values.act[id] ?? '';
      return {
        batchId: id,
        massActualKg: normalizeDecimal(values.actual[id] ?? '', 3),
        ...(d?.actRequired && act.trim() ? { discrepancyAct: act } : {}),
      };
    });
    const body = { items: built };
    const res = WaybillAcceptSchema.safeParse(body);
    if (!res.success)
      for (const issue of res.error.issues) {
        const [, index, leaf] = issue.path;
        const id = typeof index === 'number' ? items[index]?.batch.id : undefined;
        if (!id) continue;
        if (leaf === 'massActualKg') mark(`actual.${id}`, String(issue.message));
        else if (leaf === 'discrepancyAct') mark(`act.${id}`, String(issue.message));
      }
    if (marked.size > 0) return z.NEVER;
    return body satisfies Schemas['WaybillAccept'];
  });
}
