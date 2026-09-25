import { z } from 'zod';
import { codePointString, errorMap, massKg, noDuplicate, uuid } from './common.js';

const noDuplicateBatchIds = noDuplicate('batchId');

const waybillCreateItem = z
  .object(
    {
      batchId: uuid,
      massDeclaredKg: massKg,
    },
    { errorMap },
  )
  .strict();

export const WaybillCreateSchema = z
  .object(
    {
      receiverOrgId: uuid,
      items: z.array(waybillCreateItem, { errorMap }).min(1).max(100).superRefine(noDuplicateBatchIds),
    },
    { errorMap },
  )
  .strict();
export type WaybillCreate = z.infer<typeof WaybillCreateSchema>;

const waybillAcceptItem = z
  .object(
    {
      batchId: uuid,
      massActualKg: massKg,
      discrepancyAct: codePointString(1, 2000, /\S/).optional(),
    },
    { errorMap },
  )
  .strict();

export const WaybillAcceptSchema = z
  .object(
    {
      items: z.array(waybillAcceptItem, { errorMap }).min(1).max(100).superRefine(noDuplicateBatchIds),
    },
    { errorMap },
  )
  .strict();
export type WaybillAccept = z.infer<typeof WaybillAcceptSchema>;

export const WaybillRejectSchema = z
  .object(
    {
      reason: codePointString(1, 500, /\S/),
    },
    { errorMap },
  )
  .strict();
export type WaybillReject = z.infer<typeof WaybillRejectSchema>;
