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

/**
 * 400 VALIDATION where each listed field carries (at least) the listed keys (P16): a field may list further keys and
 * other fields may carry errors of their own — the order and completeness of a validator's key list is not contract.
 */
export function expectErrors(res: ApiResponse, errors: Record<string, readonly string[]>): void {
  expect(res.status, res.text).toBe(400);
  expect(res.body?.code, res.text).toBe('VALIDATION');
  for (const [field, keys] of Object.entries(errors))
    for (const key of keys) expect(res.body.errors?.[field] ?? [], `${field} in ${res.text}`).toContain(key);
}
