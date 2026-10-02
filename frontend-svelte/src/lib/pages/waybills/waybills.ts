import type { Schemas } from '@agrotrace/api-client';
import { checkDiscrepancy, compareDecimalStrings, gramsToKg, kgToGrams } from '@agrotrace/domain';
import { formatPercent } from '@agrotrace/i18n';
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
