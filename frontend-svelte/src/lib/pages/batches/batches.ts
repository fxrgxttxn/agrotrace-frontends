import type { Schemas } from '@agrotrace/api-client';
import { BATCH_STATUSES } from '@agrotrace/domain';
import { BatchCreateSchema } from '@agrotrace/validation';
import { normalizeDecimal, wireSchema } from '../../app/forms.svelte';
import type { ListSpec } from '../../app/listState.svelte';
import { momentCheck, momentWire } from '../../app/moment';
import type { Tone } from '../../ui/display';

export type Batch = Schemas['Batch'];
export type BatchItem = Schemas['BatchListItem'];
export type BatchStatus = Schemas['BatchStatus'];
export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';

export const producedOf = (b: BatchItem) => b.harvestedAt ?? b.producedAt;

export const BATCHES_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'],
  enums: { status: BATCH_STATUSES, kind: ['RAW', 'DERIVED'], holder: ['me'], origin: ['me'] },
  uuids: ['productId', 'orgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};
export const SEVERAL = '__several';

export const STATUS_TONE: Record<BatchStatus, Tone> = {
  Created: 'neutral',
  OnTest: 'attention',
  Approved: 'ok',
  InTransit: 'move',
  Accepted: 'ok',
  OnSale: 'ok',
  Processed: 'neutral',
  Sold: 'neutral',
  Blocked: 'danger',
  Recalled: 'danger-solid',
  WrittenOff: 'neutral',
};

export const LAB_STATUS_TONE: Record<Schemas['LabTestStatus'], Tone> = {
  QUEUED: 'attention',
  SAMPLED: 'move',
  DONE: 'ok',
  ESCALATED: 'danger',
  CANCELLED: 'neutral',
};

export const VSD_TONE: Record<Schemas['VsdImportStatus'], Tone> = {
  PENDING: 'move',
  IMPORTED: 'ok',
  NOT_FOUND: 'attention',
  FAILED: 'danger',
};

export interface BatchValues extends Record<string, unknown> {
  fieldId: string;
  productId: string;
  massKg: string;
  harvestedAt: string | null;
  harvestTime: string;
  original: string | null;
}
export const BATCH_FIELDS = ['fieldId', 'productId', 'massKg', 'harvestedAt', 'harvestTime'] as const;

const harvest = (v: BatchValues) => ({ date: v.harvestedAt, time: v.harvestTime, original: v.original });
export const batchSchema = wireSchema<BatchValues>(
  BatchCreateSchema,
  (v) => ({
    fieldId: v.fieldId,
    productId: v.productId,
    massKg: normalizeDecimal(v.massKg, 3),
    harvestedAt: momentWire(harvest(v)),
  }),
  (v) => momentCheck(harvest(v), 'harvestedAt', 'harvestTime'),
);

export const TABS = ['history', 'path', 'graph', 'tests', 'docs'] as const;
export type Tab = (typeof TABS)[number];

export const ACTION_TARGET: Record<string, (b: Batch) => string> = {
  ship: (b) => `/waybills/new?batchId=${b.id}`,
  accept: () => '/waybills?direction=incoming',
  reject: () => '/waybills?direction=incoming',
  process: (b) => `/processing/new?batchId=${b.id}`,
  putOnSale: () => '/stock',
  sell: () => '/stock',
  recall: (b) => `/recalls/new?batchId=${b.id}`,
  writeOff: () => '/recall-tasks',
};
