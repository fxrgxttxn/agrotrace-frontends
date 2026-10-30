/**
 * Shared primitives, mirroring the OpenAPI contract's common schemas
 * (contracts/openapi/schemas/common.yaml). Error messages are i18n keys
 * (`validation.*`), never text — see @agrotrace/i18n for translations.
 *
 * Per R36: backends never trim input and measure string length in Unicode
 * code points, not UTF-16 code units — so length checks here use
 * `[...s].length`, and nothing here trims whitespace.
 */
import { z } from 'zod';

/** Length in Unicode code points (R36) — not `.length` (UTF-16 code units). */
export const codePointLength = (s: string): number => [...s].length;

/**
 * Per-schema `ZodErrorMap` (R67 — Critical 1 fix round): maps Zod's own
 * issue codes to `validation.*` i18n keys so that a missing/mistyped field,
 * a bad enum/literal value, or an unrecognized key never surfaces Zod's
 * English default text (`"Required"`, `"Expected string, received number"`,
 * `"Invalid enum value…"`, `"Unrecognized key(s)…"`).
 *
 * This is passed explicitly as `{ errorMap }` to every `z.string()`,
 * `z.number()`, `z.boolean()`, `z.enum()`, `z.literal()`, `z.object()`,
 * `z.array()`, `z.union()`, `z.discriminatedUnion()` and `z.tuple()` call in
 * this package — deliberately NOT installed globally via `z.setErrorMap()`,
 * which would affect any other consumer of the `zod` module in the same
 * process.
 *
 * A check with its own explicit i18n-key message (e.g. `.regex(p, key)` or
 * `.refine(fn, key)`, as used throughout this file) always wins over this
 * map — Zod only consults a schema's `errorMap` when that particular issue
 * has no message of its own.
 */
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

/**
 * `z.string()` refined to a code-point length range, matching JSON Schema's
 * `maxLength`/`minLength`. A missing property is caught upstream by the
 * base `z.string({ errorMap })`'s own `invalid_type` issue
 * (→ `validation.required`); this only needs to tell "present but empty"
 * (→ `validation.required`, min > 0) apart from "present but shorter than
 * the minimum" (→ `validation.minLength`) — Important 2.
 */
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

/** FNS (Russian tax authority) INN checksum, for 10- or 12-digit INNs. */
export function isValidInn(s: string): boolean {
  if (!/^\d{10}(\d{2})?$/.test(s)) return false;
  const d = [...s].map(Number);
  if (d.length === 10) return innControlDigit(d, INN_10) === d[9];
  return innControlDigit(d, INN_11) === d[10] && innControlDigit(d, INN_12) === d[11];
}

/** INN (10 or 12 digits) with FNS checksum validation. */
export const inn = z
  .string({ errorMap })
  .regex(/^\d{10}(\d{2})?$/, 'validation.inn.format')
  .refine(isValidInn, 'validation.inn.checksum');

/** RFC 5322 email, matching the contract's `Email` schema (maxLength 254). */
export const email = z
  .string({ errorMap })
  .min(1, 'validation.required')
  .email('validation.email')
  .refine((s) => codePointLength(s) <= 254, 'validation.maxLength');

/**
 * Password: at least 10 Unicode code points (contract `Password`, spec 8.8).
 * Compared byte-exact server-side — never trimmed or normalized here.
 */
export const password = z
  .string({ errorMap })
  .min(1, 'validation.required')
  .refine((s) => codePointLength(s) >= 10, 'validation.password.min')
  .refine((s) => codePointLength(s) <= 128, 'validation.password.max');

/** UUID (contract `Uuid`). */
export const uuid = z.string({ errorMap }).uuid('validation.uuid');

/** Calendar date, `YYYY-MM-DD` (contract `Date`). */
export const isoDate = z.string({ errorMap }).regex(/^(?!0000-)\d{4}-\d{2}-\d{2}$/, 'validation.date.format');

const DATE_TIME = z.string().datetime({ offset: false });

/** Instant in UTC with a `Z` suffix (contract `DateTime`). The year 0000 is not a calendar year of the store (PL12). */
export const isoDateTime = z.string({ errorMap }).superRefine((s, ctx) => {
  if (s.startsWith('0000-') || !DATE_TIME.safeParse(s).success)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.dateTime.format' });
});

/** Percent, exactly two decimal digits (contract `Percent`). */
export const percent = z.string({ errorMap }).regex(/^\d{1,3}\.\d{2}$/, 'validation.percent.format');

/**
 * Mass in kilograms. Form-level input is looser than the wire format: up to
 * 3 decimal digits are accepted and missing digits are transformed
 * (zero-padded) to always emit exactly 3, matching the contract's
 * `PositiveMass` (`^(?!0+\.000$)\d{1,9}\.\d{3}$`). Zero (after padding) is
 * rejected as `validation.positive`.
 */
export const massKg = z
  .string({ errorMap })
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'validation.mass.format')
  .transform((s) => {
    const [intPart, decPart = ''] = s.split('.');
    return `${intPart}.${decPart.padEnd(3, '0')}`;
  })
  .refine((v) => /^(?!0+\.000$)\d{1,9}\.\d{3}$/.test(v), 'validation.positive');

/** Non-negative decimal string (contract `Decimal`: up to 8 int digits, up to 6 decimals). */
export const decimal = z.string({ errorMap }).regex(/^\d{1,8}(\.\d{1,6})?$/, 'validation.decimal.format');

/** Region code from the `regions` dictionary (contract `RegionCode`). */
export const regionCode = z.string({ errorMap }).regex(/^[0-9A-Z-]{1,8}$/, 'validation.pattern');

/** Non-blank name/title string (contract `NameString`): not only whitespace, never trimmed. */
export const nameString = codePointString(1, 255, /\S/);

/**
 * Multipart file field (contract: `{ type: 'string', format: 'binary' }`).
 * These endpoints accept `multipart/form-data`, not JSON, so there is no
 * wire-format `example` to validate against Ajv; the browser `File` type is
 * accepted where available (SSR/node test environments fall back to
 * accepting any non-empty value).
 */
export const fileUpload =
  typeof File !== 'undefined'
    ? z.instanceof(File, { message: 'validation.required' })
    : z.custom<unknown>((v) => v !== undefined && v !== null, { message: 'validation.required' });

/** Enforces JSON Schema `minProperties: 1` on a `.strict()`/`.partial()` object schema. */
export function atLeastOneKey<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape, 'strict', z.ZodTypeAny>,
) {
  return schema.refine((obj) => Object.keys(obj as object).length > 0, {
    message: 'validation.minProperties',
  });
}

/**
 * `superRefine` for arrays whose elements must not repeat `field` (contract: `errors["inputs[1].batchId"]`,
 * `errors["results[i].indicatorId"]`, `errors["items[i].batchId"]`): every repeated element — not the first
 * occurrence — gets `validation.duplicate` at its own `[i].field` (the path is relative to the array).
 */
export function noDuplicate<K extends string>(field: K) {
  return (items: Record<K, unknown>[], ctx: z.RefinementCtx): void => {
    const seen = new Set<unknown>();
    items.forEach((item, i) => {
      // The compared fields are uuids, which compare without case (PL10).
      const raw = item[field];
      const v = typeof raw === 'string' ? raw.toLowerCase() : raw;
      if (seen.has(v))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'validation.duplicate', path: [i, field] });
      seen.add(v);
    });
  };
}
