import { z } from 'zod';
import { decimal, fileUpload, uuid } from './common.js';

export const LabTestCreateSchema = z
  .object({
    batchId: uuid,
    labOrgId: uuid,
  })
  .strict();
export type LabTestCreate = z.infer<typeof LabTestCreateSchema>;

/** Body is optional at the operation level; when sent it must be `{}`. */
export const LabSampleRequestSchema = z.object({}).strict();
export type LabSampleRequest = z.infer<typeof LabSampleRequestSchema>;

const labResult = z
  .object({
    indicatorId: uuid,
    value: decimal,
  })
  .strict();

export const LabResultsInputSchema = z
  .object({
    results: z
      .array(labResult)
      .min(1)
      .max(200)
      .superRefine((items, ctx) => {
        const seen = new Set<string>();
        for (const item of items) {
          if (seen.has(item.indicatorId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.duplicate', path: ['results'] });
            return;
          }
          seen.add(item.indicatorId);
        }
      }),
  })
  .strict();
export type LabResultsInput = z.infer<typeof LabResultsInputSchema>;

export const ProtocolUploadSchema = z.object({ file: fileUpload }).strict();
export type ProtocolUpload = z.infer<typeof ProtocolUploadSchema>;
