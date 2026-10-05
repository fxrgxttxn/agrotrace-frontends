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

export function formatErrorPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '_root';
  return path.reduce<string>(
    (acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc === '' ? seg : `${acc}.${seg}`),
    '',
  );
}

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
