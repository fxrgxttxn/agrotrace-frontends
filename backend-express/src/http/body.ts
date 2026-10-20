/**
 * Request bodies by the shared Zod schemas of @agrotrace/validation, issues mapped by `toFieldErrors` (contract
 * `Problem.errors`). Where a form-level schema is looser than the wire format, the wire check adds the contract's key:
 * masses (`Mass`/`PositiveMass`: exactly three decimals — "the server does not normalize other forms") — a string
 * mass without them is `validation.mass.format` at its path.
 */
import type { z } from 'zod';
import { toFieldErrors } from '@agrotrace/validation';
import { validationProblem } from './problem.js';

/** Contract `Mass`/`PositiveMass`: exactly three decimals. */
export const WIRE_MASS = /^\d{1,9}\.\d{3}$/;

/** Mass fields to check on the wire: a top-level field name, or `[arrayField, itemField]`. */
export type MassPath = string | readonly [string, string];

export interface ParseOptions {
  /**
   * Array fields whose `validation.duplicate` (the shared schemas' noDuplicate refinement) the operation reports at a
   * later step of its own check order (createWaybill: with the references, step 2; acceptWaybill: as
   * `items.mismatch`, step 6). When duplicates there are the only schema errors, the body passes as is — every other
   * constraint held, and with the wire mass check the values equal the schema's output.
   */
  deferDuplicates?: readonly string[];
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  masses: readonly MassPath[] = [],
  opts: ParseOptions = {},
): z.output<S> {
  const result = schema.safeParse(raw);
  const errors: Record<string, string[]> = result.success ? {} : toFieldErrors(result.error);
  let deferredOnly = false;
  if (!result.success && opts.deferDuplicates?.length) {
    const deferred = (path: string) =>
      opts.deferDuplicates!.some((a) => new RegExp(`^${a}\\[\\d+\\]\\.[A-Za-z]+$`).test(path));
    deferredOnly = Object.entries(errors).every(
      ([path, keys]) => deferred(path) && keys.every((k) => k === 'validation.duplicate'),
    );
  }
  const add = (path: string) => {
    if (!errors[path]) errors[path] = ['validation.mass.format'];
  };
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const m of masses) {
      if (typeof m === 'string') {
        const v = obj[m];
        if (typeof v === 'string' && !WIRE_MASS.test(v)) add(m);
        continue;
      }
      const [array, field] = m;
      const list = obj[array];
      if (!Array.isArray(list)) continue;
      list.forEach((item, i) => {
        const v = (item as Record<string, unknown> | null)?.[field];
        if (typeof v === 'string' && !WIRE_MASS.test(v)) add(`${array}[${i}].${field}`);
      });
    }
  }
  const wireErrors = Object.entries(errors).some(([, keys]) => keys.includes('validation.mass.format'));
  if (deferredOnly && !wireErrors) return raw as z.output<S>;
  if (Object.keys(errors).length > 0) throw validationProblem(errors);
  return (result as { data: z.output<S> }).data;
}
