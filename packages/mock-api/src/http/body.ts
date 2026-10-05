import type { z } from 'zod';
import { toFieldErrors } from '@agrotrace/validation';
import { ApiError, validation } from './problem.js';

export const JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

export async function readJson(request: Request, optional = false): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > JSON_BODY_LIMIT_BYTES)
    throw new ApiError(413, 'FILE_TOO_LARGE', { params: { maxBytes: JSON_BODY_LIMIT_BYTES } });
  if (text === '') {
    if (optional) return undefined;
    throw validation({ _root: ['validation.invalid'] });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validation({ _root: ['validation.invalid'] });
  }
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  wire?: (raw: Record<string, unknown>, add: (path: string, key: string) => void) => void,
): z.output<S> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw validation({ _root: ['validation.type'] });
  let result: z.SafeParseReturnType<unknown, z.output<S>>;
  try {
    result = schema.safeParse(raw);
  } catch {
    throw validation({ _root: ['validation.invalid'] });
  }
  const errors: Record<string, string[]> = result.success ? {} : toFieldErrors(result.error);
  if (wire) {
    wire(raw as Record<string, unknown>, (path, key) => {
      if (!errors[path]) errors[path] = [key];
    });
  }
  if (Object.keys(errors).length > 0) throw validation(errors);
  return (result as { data: z.output<S> }).data;
}

export const WIRE_MASS = /^\d{1,9}\.\d{3}$/;

export function massWire(
  raw: Record<string, unknown>,
  add: (path: string, key: string) => void,
  arrays: [array: string, field: string][],
): void {
  for (const [array, field] of arrays) {
    const list = raw[array];
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => {
      const v = (item as Record<string, unknown> | null)?.[field];
      if (typeof v === 'string' && !WIRE_MASS.test(v)) add(`${array}[${i}].${field}`, 'validation.mass.format');
    });
  }
}
