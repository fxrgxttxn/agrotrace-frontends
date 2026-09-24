import { z } from 'zod';
import { codePointString, massKg, uuid } from './common.js';

function noDuplicateBatchIds<T extends { batchId: string }>(items: T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.batchId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.duplicate', path: ['items'] });
      return;
    }
    seen.add(item.batchId);
  }
}

const waybillCreateItem = z
  .object({
    batchId: uuid,
    massDeclaredKg: massKg,
  })
  .strict();

export const WaybillCreateSchema = z
  .object({
    receiverOrgId: uuid,
    items: z.array(waybillCreateItem).min(1).max(100).superRefine(noDuplicateBatchIds),
  })
  .strict();
export type WaybillCreate = z.infer<typeof WaybillCreateSchema>;

const waybillAcceptItem = z
  .object({
    batchId: uuid,
    massActualKg: massKg,
    discrepancyAct: codePointString(1, 2000, /\S/).optional(),
  })
  .strict();

export const WaybillAcceptSchema = z
  .object({
    items: z.array(waybillAcceptItem).min(1).max(100).superRefine(noDuplicateBatchIds),
  })
  .strict();
export type WaybillAccept = z.infer<typeof WaybillAcceptSchema>;

export const WaybillRejectSchema = z
  .object({
    reason: codePointString(1, 500, /\S/),
  })
  .strict();
export type WaybillReject = z.infer<typeof WaybillRejectSchema>;
