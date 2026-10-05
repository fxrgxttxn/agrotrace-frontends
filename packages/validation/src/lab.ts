import { z } from 'zod';
import { decimal, errorMap, fileUpload, noDuplicate, uuid } from './common.js';

export const LabTestCreateSchema = z
  .object(
    {
      batchId: uuid,
      labOrgId: uuid,
    },
    { errorMap },
  )
  .strict();
export type LabTestCreate = z.infer<typeof LabTestCreateSchema>;

export const LabSampleRequestSchema = z.object({}, { errorMap }).strict();
export type LabSampleRequest = z.infer<typeof LabSampleRequestSchema>;

const labResult = z
  .object(
    {
      indicatorId: uuid,
      value: decimal,
    },
    { errorMap },
  )
  .strict();

export const LabResultsInputSchema = z
  .object(
    {
      results: z.array(labResult, { errorMap }).min(1).max(200).superRefine(noDuplicate('indicatorId')),
    },
    { errorMap },
  )
  .strict();
export type LabResultsInput = z.infer<typeof LabResultsInputSchema>;

export const ProtocolUploadSchema = z.object({ file: fileUpload }, { errorMap }).strict();
export type ProtocolUpload = z.infer<typeof ProtocolUploadSchema>;
