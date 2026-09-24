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

/** `z.string()` refined to a code-point length range, matching JSON Schema's `maxLength`/`minLength`. */
export function codePointString(min: number, max: number, pattern?: RegExp) {
  return z
    .string()
    .refine((s) => codePointLength(s) >= min, min > 0 ? 'validation.required' : 'validation.minLength')
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
  .string()
  .regex(/^\d{10}(\d{2})?$/, 'validation.inn.format')
  .refine(isValidInn, 'validation.inn.checksum');

/** RFC 5322 email, matching the contract's `Email` schema (maxLength 254). */
export const email = z
  .string()
  .min(1, 'validation.required')
  .email('validation.email')
  .refine((s) => codePointLength(s) <= 254, 'validation.maxLength');

/**
 * Password: at least 10 Unicode code points (contract `Password`, spec 8.8).
 * Compared byte-exact server-side — never trimmed or normalized here.
 */
export const password = z
  .string()
  .min(1, 'validation.required')
  .refine((s) => codePointLength(s) >= 10, 'validation.password.min')
  .refine((s) => codePointLength(s) <= 128, 'validation.password.max');

/** UUID (contract `Uuid`). */
export const uuid = z.string().uuid('validation.uuid');

/** Calendar date, `YYYY-MM-DD` (contract `Date`). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date.format');

/** Instant in UTC with a `Z` suffix (contract `DateTime`). */
export const isoDateTime = z.string().datetime({ offset: false, message: 'validation.dateTime.format' });

/** Percent, exactly two decimal digits (contract `Percent`). */
export const percent = z.string().regex(/^\d{1,3}\.\d{2}$/, 'validation.percent.format');

/**
 * Mass in kilograms. Form-level input is looser than the wire format: up to
 * 3 decimal digits are accepted and missing digits are transformed
 * (zero-padded) to always emit exactly 3, matching the contract's
 * `PositiveMass` (`^(?!0+\.000$)\d{1,9}\.\d{3}$`). Zero (after padding) is
 * rejected as `validation.positive`.
 */
export const massKg = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'validation.mass.format')
  .transform((s) => {
    const [intPart, decPart = ''] = s.split('.');
    return `${intPart}.${decPart.padEnd(3, '0')}`;
  })
  .refine((v) => /^(?!0+\.000$)\d{1,9}\.\d{3}$/.test(v), 'validation.positive');

/** Non-negative decimal string (contract `Decimal`: up to 8 int digits, up to 6 decimals). */
export const decimal = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/, 'validation.decimal.format');

/** Region code from the `regions` dictionary (contract `RegionCode`). */
export const regionCode = z.string().regex(/^[0-9A-Z-]{1,8}$/, 'validation.pattern');

/** Non-blank name/title string (contract `NameString`): not only whitespace, never trimmed. */
export const nameString = codePointString(1, 255, /\S/);

/**
 * Multipart file field (contract: `{ type: 'string', format: 'binary' }`).
 * These endpoints accept `multipart/form-data`, not JSON, so there is no
 * wire-format `example` to validate against Ajv; the browser `File` type is
 * accepted where available (SSR/node test environments fall back to
 * accepting any non-empty value).
 */
/** Enforces JSON Schema `minProperties: 1` on a `.strict()`/`.partial()` object schema. */
export function atLeastOneKey<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape, 'strict', z.ZodTypeAny>,
) {
  return schema.refine((obj) => Object.keys(obj as object).length > 0, {
    message: 'validation.minProperties',
  });
}

export const fileUpload =
  typeof File !== 'undefined'
    ? z.instanceof(File, { message: 'validation.required' })
    : z.custom<unknown>((v) => v !== undefined && v !== null, { message: 'validation.required' });
