/**
 * `If-Match` (components/parameters.yaml#/IfMatch): the entity's current `version` as a bare integer (no quotes, no
 * `W/`), required. Read with the other parameters (400 VALIDATION under `errors["If-Match"]`): missing →
 * `validation.required`, not a decimal integer → `validation.type`, below 1 → `validation.min`; an operation with a
 * body reports these in the same 400 as the body's schema errors (P36, `readIfMatch` + parseBody `extraErrors`). The
 * comparison itself is a compare-and-set against the LOCKED row (R47): `checkVersion` inside the transaction.
 */
import type { Request } from 'express';
import { AppProblem, validationProblem } from './problem.js';

export const IF_MATCH = 'If-Match';

export type IfMatch =
  { version: number; errors?: undefined } | { version?: undefined; errors: Record<string, string[]> };

/** The header's version or its errors (not thrown — for merging with the body's errors). */
export function readIfMatch(req: Request): IfMatch {
  const raw = req.headers['if-match'];
  if (raw === undefined || raw === '') return { errors: { [IF_MATCH]: ['validation.required'] } };
  if (!/^\d{1,10}$/.test(raw)) return { errors: { [IF_MATCH]: ['validation.type'] } };
  const n = Number(raw);
  if (n < 1) return { errors: { [IF_MATCH]: ['validation.min'] } };
  return { version: n };
}

/** The version, or the 400 at once (operations without a body). */
export function ifMatchVersion(req: Request): number {
  const r = readIfMatch(req);
  if (r.errors) throw validationProblem(r.errors);
  return r.version;
}

/** 409 VERSION_CONFLICT `{currentVersion}` when the locked row's version differs from `If-Match`. */
export function checkVersion(expected: number, current: number): void {
  if (expected !== current)
    throw new AppProblem(409, 'VERSION_CONFLICT', { params: { currentVersion: current } });
}
