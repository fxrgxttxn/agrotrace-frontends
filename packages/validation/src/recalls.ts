import { z } from 'zod';
import { codePointString, errorMap, uuid } from './common.js';

export const RecallCreateSchema = z
  .object(
    {
      sourceBatchId: uuid,
      reason: codePointString(1, 1000, /\S/),
      blockUpstream: z.boolean({ errorMap }),
    },
    { errorMap },
  )
  .strict();
export type RecallCreate = z.infer<typeof RecallCreateSchema>;

export const RecallTaskConfirmSchema = z.object({}, { errorMap }).strict();
export type RecallTaskConfirm = z.infer<typeof RecallTaskConfirmSchema>;
