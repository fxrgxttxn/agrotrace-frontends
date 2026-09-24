import { z } from 'zod';
import { errorMap, massKg, uuid } from './common.js';

const processingInput = z
  .object(
    {
      batchId: uuid,
      massUsedKg: massKg,
    },
    { errorMap },
  )
  .strict();

const processingOutput = z
  .object(
    {
      productId: uuid,
      massKg,
    },
    { errorMap },
  )
  .strict();

export const ProcessingRequestSchema = z
  .object(
    {
      inputs: z
        .array(processingInput, { errorMap })
        .min(1)
        .max(50)
        .superRefine((items, ctx) => {
          const seen = new Set<string>();
          for (const item of items) {
            if (seen.has(item.batchId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'validation.duplicate',
                path: ['inputs'],
              });
              return;
            }
            seen.add(item.batchId);
          }
        }),
      outputs: z.array(processingOutput, { errorMap }).min(1).max(20),
    },
    { errorMap },
  )
  .strict();
export type ProcessingRequest = z.infer<typeof ProcessingRequestSchema>;
