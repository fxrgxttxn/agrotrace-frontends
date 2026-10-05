import { z } from 'zod';
import { errorMap, massKg, noDuplicate, uuid } from './common.js';

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
      inputs: z.array(processingInput, { errorMap }).min(1).max(50).superRefine(noDuplicate('batchId')),
      outputs: z.array(processingOutput, { errorMap }).min(1).max(20),
    },
    { errorMap },
  )
  .strict();
export type ProcessingRequest = z.infer<typeof ProcessingRequestSchema>;
