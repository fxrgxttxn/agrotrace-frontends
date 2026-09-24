import type { z } from 'zod';

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
 */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    (out[path] ??= []).push(issue.message);
  }
  return out;
}
