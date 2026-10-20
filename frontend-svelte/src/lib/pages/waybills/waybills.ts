import { z } from 'zod';
import type { Schemas } from '@agrotrace/api-client';
import { checkDiscrepancy, compareDecimalStrings, gramsToKg, kgToGrams } from '@agrotrace/domain';
import { formatPercent } from '@agrotrace/i18n';
import { WaybillAcceptSchema, WaybillCreateSchema } from '@agrotrace/validation';
import { normalizeDecimal } from '../../app/forms.svelte';
import { LOCALE, t } from '../../app/i18n';
import type { ListSpec } from '../../app/listState.svelte';
import type { Tone } from '../../ui/display';

// Waybills (FR-PROD-05, БП-3, R4: DRAFT → send → SENT → accept | reject; a draft can be deleted). What the viewer may
// do comes from `Waybill.actions` (the server's list). The same rules as the React app (src/pages/waybills.tsx there).

export type Waybill = Schemas['Waybill'];
export type WaybillStatus = Schemas['WaybillStatus'];
export type BatchItem = Schemas['BatchListItem'];
export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';
export const WAYBILL_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
export const SEVERAL = '__several';

/** Colour group of a waybill status (README «Статус»: `data-tone` for other entities). */
export const WAYBILL_TONE: Record<WaybillStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'move',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

// Participants filter by direction; INSPECTOR/ADMIN may not (400 `direction.notAllowed`, R51) and pick a counterparty.
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

/** Sum of masses (exact, in grams — never floats). */
export function totalKg(masses: string[]): string {
  return gramsToKg(masses.reduce((s, m) => s + kgToGrams(m), 0n));
}

/** A mass for an input: `12480.000` → `12480,000` (normalizeDecimal reads it back). */
export const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

/** Live discrepancy of an item (domain `checkDiscrepancy`, BR-07); `null` while the typed mass is not a mass yet. */
export function discrepancyOf(
  declaredKg: string,
  actualText: string,
): { percent: string; actRequired: boolean } | null {
  const actualKg = normalizeDecimal(actualText, 3);
  if (!/^\d{1,9}\.\d{3}$/.test(actualKg)) return null;
  const r = checkDiscrepancy({ declaredKg, actualKg });
  return 'error' in r ? null : r;
}

/** The discrepancy as shown: its percent, except when rounding would hide that it is over the threshold (a 2.004%
 * discrepancy rounds to «2,00%» while the act is required — FM13): then «больше 2%», from the domain's comparison. */
export function discrepancyText(d: { percent: string; actRequired: boolean }): string {
  return d.actRequired && compareDecimalStrings(d.percent, '2.00') <= 0
    ? t('waybills.overLimit')
    : formatPercent(d.percent, LOCALE);
}

// ── /waybills/new: the draft form (a selectable table, one declared mass per row) ──────────────────────────────────

export interface WaybillNewValues extends Record<string, unknown> {
  receiverOrgId: string;
  picked: string[];
  mass: Record<string, string>;
}

/** A schema over the form's own values (keyed by batch id, as `SchemaForm` needs for its per-row `mass.<id>`
 * fields): required receiver and at least one picked batch, the shared `WaybillCreateSchema` (its `items[i].*`
 * issues mapped back to the row they came from), the mass-exceeds-batch domain check the server would also make.
 * `batches` is this screen's fixed stock list (its ids never change while the form is mounted). */
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

// ── /waybills/:id — acceptance (BR-07) ──────────────────────────────────────────────────────────────────────────────

export interface AcceptValues extends Record<string, unknown> {
  actual: Record<string, string>;
  act: Record<string, string>;
}

/** A schema over the acceptance form's values (keyed by batch id): required actual mass per item, the act required
 * only when the live BR-07 discrepancy of that item asks for it, the shared `WaybillAcceptSchema`'s issues mapped
 * back to their row. `items` is the waybill's current items (the caller re-builds this schema when they change). */
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
        // The act is asked for (and sent) only when BR-07 requires it.
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
