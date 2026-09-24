import { z } from 'zod';
import { atLeastOneKey, decimal, fileUpload, nameString, regionCode, uuid } from './common.js';

export const OrganizationAdminPatchSchema = atLeastOneKey(
  z
    .object({
      name: nameString,
      address: z
        .string()
        .max(500, 'validation.maxLength')
        .refine((s) => /\S/.test(s), 'validation.pattern')
        .nullable(),
      regionCode,
      status: z.enum(['ACTIVE', 'REJECTED', 'SUSPENDED']),
    })
    .partial()
    .strict(),
);
export type OrganizationAdminPatch = z.infer<typeof OrganizationAdminPatchSchema>;

const dictionaryName = (min: number, max: number) =>
  z
    .string()
    .min(min, 'validation.required')
    .max(max, 'validation.maxLength')
    .refine((s) => /\S/.test(s), 'validation.pattern');

export const ProductCategorySchema = z.enum([
  'GRAIN',
  'VEGETABLE',
  'FRUIT',
  'DAIRY',
  'MEAT',
  'OILSEED',
  'PROCESSED',
]);

export const SubstanceTypeSchema = z.enum(['PESTICIDE', 'FERTILIZER']);

export const ProductInputSchema = z
  .object({
    name: dictionaryName(1, 160),
    category: ProductCategorySchema,
    lossNormPercent: z.string().regex(/^(100\.00|\d{1,2}\.\d{2})$/, 'validation.percent.format'),
  })
  .strict();
export type ProductInput = z.infer<typeof ProductInputSchema>;

export const SubstanceInputSchema = z
  .object({
    name: dictionaryName(1, 160),
    type: SubstanceTypeSchema,
    waitingPeriodDays: z.number().int().min(0).max(3650),
  })
  .strict();
export type SubstanceInput = z.infer<typeof SubstanceInputSchema>;

export const IndicatorInputSchema = z
  .object({
    name: dictionaryName(1, 160),
    unit: dictionaryName(1, 24),
  })
  .strict();
export type IndicatorInput = z.infer<typeof IndicatorInputSchema>;

export const NormInputSchema = z
  .object({
    productId: uuid,
    indicatorId: uuid,
    maxValue: decimal,
  })
  .strict();
export type NormInput = z.infer<typeof NormInputSchema>;

export const RegionInputSchema = z
  .object({
    code: regionCode,
    name: dictionaryName(1, 120),
  })
  .strict();
export type RegionInput = z.infer<typeof RegionInputSchema>;

export const DictionaryInputSchema = z.union([
  ProductInputSchema,
  SubstanceInputSchema,
  IndicatorInputSchema,
  NormInputSchema,
  RegionInputSchema,
]);
export type DictionaryInput = z.infer<typeof DictionaryInputSchema>;

export const ImportUploadSchema = z.object({ file: fileUpload }).strict();
export type ImportUpload = z.infer<typeof ImportUploadSchema>;
