/**
 * `If-Match` (components/parameters.yaml#/IfMatch): the entity's current `version` as a bare integer (no quotes, no
 * `W/`), required. Read with the other parameters (400 VALIDATION under `errors["If-Match"]`): missing →
 * `validation.required`, not a decimal integer → `validation.type`, below 1 → `validation.min`. The comparison itself
 * is a compare-and-set against the LOCKED row (R47): `checkVersion` inside the transaction.
 */
import type { Request } from 'express';
import { AppProblem, validationProblem } from './problem.js';

export const IF_MATCH = 'If-Match';

export function ifMatchVersion(req: Request): number {
  const raw = req.headers['if-match'];
  if (raw === undefined || raw === '') throw validationProblem({ [IF_MATCH]: ['validation.required'] });
  if (!/^\d{1,10}$/.test(raw)) throw validationProblem({ [IF_MATCH]: ['validation.type'] });
  const n = Number(raw);
  if (n < 1) throw validationProblem({ [IF_MATCH]: ['validation.min'] });
  return n;
}

/** 409 VERSION_CONFLICT `{currentVersion}` when the locked row's version differs from `If-Match`. */
export function checkVersion(expected: number, current: number): void {
  if (expected !== current)
    throw new AppProblem(409, 'VERSION_CONFLICT', { params: { currentVersion: current } });
}
