import { ZodIssueCode, type z } from 'zod';

export * from './common.js';
export * from './auth.js';
export * from './fields.js';
export * from './batches.js';
export * from './waybills.js';
export * from './processing.js';
export * from './lab.js';
export * from './recalls.js';
export * from './complaints.js';
export * from './admin.js';
export * from './profile.js';

/**
 * Formats a Zod issue path the way the contract writes `Problem.errors` keys (info.description): segments joined by
 * dots, array indices in brackets — `items[0].batchId`; an issue at the root of the body is `_root`.
 */
export function formatErrorPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '_root';
  return path.reduce<string>(
    (acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc === '' ? seg : `${acc}.${seg}`),
    '',
  );
}

/**
 * Flattens a ZodError into the same shape as `Problem.errors`: field path
 * (contract form, `formatErrorPath`: `items[0].massDeclaredKg`) to a list of i18n keys.
 *
 * `unrecognized_keys` is a single Zod issue at the *object's* path listing
 * every offending key in `issue.keys`; it is expanded here into one entry
 * per key, at that key's own path (Critical 1 / R67), rather than reported
 * once at the object's own path (or `_root`).
 */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.code === ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) {
        const path = formatErrorPath([...issue.path, key]);
        (out[path] ??= []).push(issue.message);
      }
      continue;
    }
    const path = formatErrorPath(issue.path);
    (out[path] ??= []).push(issue.message);
  }
  return out;
}
