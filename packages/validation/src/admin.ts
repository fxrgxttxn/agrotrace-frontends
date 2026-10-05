import { z } from 'zod';
import {
  atLeastOneKey,
  codePointString,
  decimal,
  errorMap,
  fileUpload,
  nameString,
  regionCode,
  uuid,
} from './common.js';

export const OrganizationAdminPatchSchema = atLeastOneKey(
  z
    .object(
      {
        name: nameString,
        address: codePointString(0, 500, /\S/).nullable(),
        regionCode,
        status: z.enum(['ACTIVE', 'REJECTED', 'SUSPENDED'], { errorMap }),
      },
      { errorMap },
    )
    .partial()
    .strict(),
);
export type OrganizationAdminPatch = z.infer<typeof OrganizationAdminPatchSchema>;

export const ProductCategorySchema = z.enum(
  ['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED'],
  { errorMap },
);

export const SubstanceTypeSchema = z.enum(['PESTICIDE', 'FERTILIZER'], { errorMap });

export const ProductInputSchema = z
  .object(
    {
      name: codePointString(1, 160, /\S/),
      category: ProductCategorySchema,
      lossNormPercent: z
        .string({ errorMap })
        .regex(/^(100\.00|\d{1,2}\.\d{2})$/, 'validation.percent.format'),
      mercuryCode: z
        .string({ errorMap })
        .max(16, 'validation.maxLength')
        .regex(/^\d{2}(\.\d{1,3}){1,3}$/, 'validation.mercuryCode.format')
        .nullable()
        .optional(),
    },
    { errorMap },
  )
  .strict();
export type ProductInput = z.infer<typeof ProductInputSchema>;

export const SubstanceInputSchema = z
  .object(
    {
      name: codePointString(1, 160, /\S/),
      type: SubstanceTypeSchema,
      waitingPeriodDays: z.number({ errorMap }).int().min(0).max(3650),
    },
    { errorMap },
  )
  .strict();
export type SubstanceInput = z.infer<typeof SubstanceInputSchema>;

export const IndicatorInputSchema = z
  .object(
    {
      name: codePointString(1, 160, /\S/),
      unit: codePointString(1, 24, /\S/),
    },
    { errorMap },
  )
  .strict();
export type IndicatorInput = z.infer<typeof IndicatorInputSchema>;

export const NormInputSchema = z
  .object(
    {
      productId: uuid,
      indicatorId: uuid,
      maxValue: decimal,
    },
    { errorMap },
  )
  .strict();
export type NormInput = z.infer<typeof NormInputSchema>;

export const RegionInputSchema = z
  .object(
    {
      code: regionCode,
      name: codePointString(1, 120, /\S/),
    },
    { errorMap },
  )
  .strict();
export type RegionInput = z.infer<typeof RegionInputSchema>;

export const DictionaryInputSchema = z.union(
  [ProductInputSchema, SubstanceInputSchema, IndicatorInputSchema, NormInputSchema, RegionInputSchema],
  { errorMap },
);
export type DictionaryInput = z.infer<typeof DictionaryInputSchema>;

export const ImportUploadSchema = z.object({ file: fileUpload }, { errorMap }).strict();
export type ImportUpload = z.infer<typeof ImportUploadSchema>;
