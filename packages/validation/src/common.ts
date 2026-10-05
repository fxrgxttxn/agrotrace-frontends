import { z } from 'zod';

export const codePointLength = (s: string): number => [...s].length;

export const errorMap: z.ZodErrorMap = (issue) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return {
        message: issue.received === z.ZodParsedType.undefined ? 'validation.required' : 'validation.type',
      };
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: 'validation.enum' };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: 'validation.unknownField' };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: 'validation.minLength' };
      if (issue.type === 'array' || issue.type === 'set') return { message: 'validation.minItems' };
      return { message: 'validation.min' };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: 'validation.maxLength' };
      if (issue.type === 'array' || issue.type === 'set') return { message: 'validation.maxItems' };
      return { message: 'validation.max' };
    case z.ZodIssueCode.invalid_union:
      return { message: 'validation.invalid' };
    default:
      return { message: 'validation.invalid' };
  }
};

export function codePointString(min: number, max: number, pattern?: RegExp) {
  return z
    .string({ errorMap })
    .refine(
      (s) => codePointLength(s) >= min,
      (s) => ({ message: codePointLength(s) === 0 ? 'validation.required' : 'validation.minLength' }),
    )
    .refine((s) => codePointLength(s) <= max, 'validation.maxLength')
    .refine((s) => !pattern || pattern.test(s), 'validation.pattern');
}

const INN_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

const innControlDigit = (digits: number[], weights: number[]): number =>
  (weights.reduce((sum, w, i) => sum + w * digits[i]!, 0) % 11) % 10;

export function isValidInn(s: string): boolean {
  if (!/^\d{10}(\d{2})?$/.test(s)) return false;
  const d = [...s].map(Number);
  if (d.length === 10) return innControlDigit(d, INN_10) === d[9];
  return innControlDigit(d, INN_11) === d[10] && innControlDigit(d, INN_12) === d[11];
}

export const inn = z
  .string({ errorMap })
  .regex(/^\d{10}(\d{2})?$/, 'validation.inn.format')
  .refine(isValidInn, 'validation.inn.checksum');

export const email = z
  .string({ errorMap })
  .min(1, 'validation.required')
  .email('validation.email')
  .refine((s) => codePointLength(s) <= 254, 'validation.maxLength');

export const password = z
  .string({ errorMap })
  .min(1, 'validation.required')
  .refine((s) => codePointLength(s) >= 10, 'validation.password.min')
  .refine((s) => codePointLength(s) <= 128, 'validation.password.max');

export const uuid = z.string({ errorMap }).uuid('validation.uuid');

export const isoDate = z.string({ errorMap }).regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date.format');

export const isoDateTime = z
  .string({ errorMap })
  .datetime({ offset: false, message: 'validation.dateTime.format' });

export const percent = z.string({ errorMap }).regex(/^\d{1,3}\.\d{2}$/, 'validation.percent.format');

export const massKg = z
  .string({ errorMap })
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'validation.mass.format')
  .transform((s) => {
    const [intPart, decPart = ''] = s.split('.');
    return `${intPart}.${decPart.padEnd(3, '0')}`;
  })
  .refine((v) => /^(?!0+\.000$)\d{1,9}\.\d{3}$/.test(v), 'validation.positive');

export const decimal = z.string({ errorMap }).regex(/^\d{1,8}(\.\d{1,6})?$/, 'validation.decimal.format');

export const regionCode = z.string({ errorMap }).regex(/^[0-9A-Z-]{1,8}$/, 'validation.pattern');

export const nameString = codePointString(1, 255, /\S/);

export const fileUpload =
  typeof File !== 'undefined'
    ? z.instanceof(File, { message: 'validation.required' })
    : z.custom<unknown>((v) => v !== undefined && v !== null, { message: 'validation.required' });

export function atLeastOneKey<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape, 'strict', z.ZodTypeAny>,
) {
  return schema.refine((obj) => Object.keys(obj as object).length > 0, {
    message: 'validation.minProperties',
  });
}

export function noDuplicate<K extends string>(field: K) {
  return (items: Record<K, unknown>[], ctx: z.RefinementCtx): void => {
    const seen = new Set<unknown>();
    items.forEach((item, i) => {
      const v = item[field];
      if (seen.has(v))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.duplicate', path: [i, field] });
      seen.add(v);
    });
  };
}
