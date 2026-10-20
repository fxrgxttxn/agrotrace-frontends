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
   * Array fields whose `validation.duplicate` (the shared schemas' noDuplicate refinement) the operation reports only
   * at its own later step (P36: createWaybill — with the references, step 2; acceptWaybill — as `items.mismatch`,
   * step 6). Those issues are always dropped from the schema-stage errors; when nothing else is wrong the body passes
   * as is — every other constraint held, and with the wire mass check the values equal the schema's output.
   */
  deferDuplicates?: readonly string[];
  /** Errors of the request's other parameters (e.g. `If-Match`), reported in the same 400 (P36). */
  extraErrors?: Record<string, string[]>;
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  masses: readonly MassPath[] = [],
  opts: ParseOptions = {},
): z.output<S> {
  const result = schema.safeParse(raw);
  const errors: Record<string, string[]> = result.success ? {} : toFieldErrors(result.error);
  if (!result.success && opts.deferDuplicates?.length) {
    const deferred = (path: string) =>
      opts.deferDuplicates!.some((a) => new RegExp(`^${a}\\[\\d+\\]\\.[A-Za-z]+$`).test(path));
    for (const [path, keys] of Object.entries(errors)) {
      if (!deferred(path)) continue;
      const rest = keys.filter((k) => k !== 'validation.duplicate');
      if (rest.length > 0) errors[path] = rest;
      else delete errors[path];
    }
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
  for (const [path, keys] of Object.entries(opts.extraErrors ?? {})) (errors[path] ??= []).push(...keys);
  if (Object.keys(errors).length > 0) throw validationProblem(errors);
  // Only deferred duplicates failed the schema: the raw body is otherwise valid (see deferDuplicates).
  return (result.success ? result.data : raw) as z.output<S>;
}
