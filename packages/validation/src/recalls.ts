import { z } from 'zod';
import { codePointString, uuid } from './common.js';

export const RecallCreateSchema = z
  .object({
    sourceBatchId: uuid,
    reason: codePointString(1, 1000, /\S/),
    blockUpstream: z.boolean(),
  })
  .strict();
export type RecallCreate = z.infer<typeof RecallCreateSchema>;

/** Body is optional at the operation level; when sent it must be `{}`. */
export const RecallTaskConfirmSchema = z.object({}).strict();
export type RecallTaskConfirm = z.infer<typeof RecallTaskConfirmSchema>;
