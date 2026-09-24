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
 * Flattens a ZodError into the same shape as `Problem.errors`: field path
 * (dot-joined, array indices as plain numbers, e.g. `items.0.massDeclaredKg`)
 * to a list of i18n keys.
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
        const path = [...issue.path, key].join('.');
        (out[path] ??= []).push(issue.message);
      }
      continue;
    }
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    (out[path] ??= []).push(issue.message);
  }
  return out;
}
