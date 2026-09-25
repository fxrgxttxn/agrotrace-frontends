/** Problem assertions shared by the suites (the contract shape itself is checked by expectContract). */
import { expect } from 'vitest';
import type { ApiResponse } from './client.js';

/** Status and `code`; with `params`, the exact params (`null` — no params at all, e.g. 403 by role). */
export function expectProblem(
  res: ApiResponse,
  status: number,
  code: string,
  params?: Record<string, unknown> | null,
): void {
  expect(res.status, res.text).toBe(status);
  expect(res.body?.code, res.text).toBe(code);
  if (params === null) expect(res.body.params, res.text).toBeUndefined();
  else if (params !== undefined) expect(res.body.params, res.text).toEqual(params);
}

/** 400 VALIDATION with exactly these field errors. */
export function expectErrors(res: ApiResponse, errors: Record<string, readonly string[]>): void {
  expect(res.status, res.text).toBe(400);
  expect(res.body?.code, res.text).toBe('VALIDATION');
  expect(res.body.errors, res.text).toEqual(errors);
}
