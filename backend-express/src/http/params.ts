/**
 * Path and query parameters by the contract's schemas (components/parameters.yaml): every problem is a 400
 * VALIDATION entry under the parameter's name, all parameters of a request are reported together. Query values come
 * from Express's parser: a scalar parameter given twice (an array) or in bracket form (an object) is `validation.type`.
 */
import type { Request } from 'express';
import { codePointLength } from '@agrotrace/validation';
import { validationProblem } from './problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/** `IdPath` (uuid) → the id in lower case; otherwise 400 `errors.<name>: [validation.uuid]`. */
export function idParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!isUuid(v)) throw validationProblem({ [name]: ['validation.uuid'] });
  return v.toLowerCase();
}

export type Sort = { field: string; dir: 'asc' | 'desc' };

/** Accumulates the errors of a request's query parameters. */
export class QueryReader {
  readonly errors: Record<string, string[]> = {};

  constructor(private readonly query: Request['query']) {}

  private add(name: string, key: string): undefined {
    (this.errors[name] ??= []).push(key);
    return undefined;
  }

  has(name: string): boolean {
    return this.query[name] !== undefined;
  }

  string(name: string): string | undefined {
    const v = this.query[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') return this.add(name, 'validation.type');
    return v;
  }

  /** Integer in [min, max] (the contract's `minimum`/`maximum`); `fallback` when absent. */
  int(name: string, min: number, max: number | null, fallback?: number): number | undefined {
    const s = this.string(name);
    if (s === undefined) return this.errors[name] ? undefined : fallback;
    if (!/^-?\d{1,15}$/.test(s)) return this.add(name, 'validation.type');
    const n = Number(s);
    if (n < min) return this.add(name, 'validation.min');
    if (max !== null && n > max) return this.add(name, 'validation.max');
    return n;
  }

  enumOf<T extends string>(name: string, values: readonly T[]): T | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!(values as readonly string[]).includes(s)) return this.add(name, 'validation.enum');
    return s as T;
  }

  /** A repeatable (`explode: true`) enum parameter: `?type=A&type=B`; duplicates → validation.duplicate. */
  enumList<T extends string>(name: string, values: readonly T[]): T[] | undefined {
    const raw = this.query[name];
    if (raw === undefined) return undefined;
    const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
    if (list === null || list.some((x) => typeof x !== 'string')) return this.add(name, 'validation.type');
    if (list.some((x) => !(values as readonly string[]).includes(x as string)))
      return this.add(name, 'validation.enum');
    if (new Set(list).size !== list.length) return this.add(name, 'validation.duplicate');
    return list as T[];
  }

  uuid(name: string): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!isUuid(s)) return this.add(name, 'validation.uuid');
    return s.toLowerCase();
  }

  /** `Q`: 1…100 code points. */
  q(name = 'q'): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    const len = codePointLength(s);
    if (len < 1) return this.add(name, 'validation.minLength');
    if (len > 100) return this.add(name, 'validation.maxLength');
    return s;
  }

  /** A string with the contract's `maxLength` (code points). */
  text(name: string, maxLength: number): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (codePointLength(s) > maxLength) return this.add(name, 'validation.maxLength');
    return s;
  }

  /** A string matching `pattern` (the contract's `pattern`, e.g. RegionCode) — otherwise `validation.pattern`. */
  matching(name: string, pattern: RegExp): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!pattern.test(s)) return this.add(name, 'validation.pattern');
    return s;
  }

  /** `type: boolean` — exactly `true` or `false`. */
  bool(name: string): boolean | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (s !== 'true' && s !== 'false') return this.add(name, 'validation.type');
    return s === 'true';
  }

  /** `format: date` — a real calendar date `YYYY-MM-DD`. */
  date(name: string): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!isCalendarDate(s)) return this.add(name, 'validation.date.format');
    return s;
  }

  /** `DateFrom`/`DateTo` (UTC dates, inclusive): `from` after `to` → `errors.from: [validation.range]`. */
  dateRange(): { from?: string; to?: string } {
    const from = this.date('from');
    const to = this.date('to');
    if (from !== undefined && to !== undefined && from > to) this.add('from', 'validation.range');
    return { from, to };
  }

  /** A filter this caller or this request may not use (R51): present → `validation.<name>.notAllowed`. */
  notAllowed(name: string): void {
    if (this.has(name)) this.errors[name] = [`validation.${name}.notAllowed`];
  }

  /** `Page`, `Size` (1…100, default 20) and `Sort` against the operation's `x-sort`. */
  page(xSort: { fields: readonly string[]; default: string }): { page: number; size: number; sort: Sort } {
    const page = this.int('page', 1, null, 1) ?? 1;
    const size = this.int('size', 1, 100, 20) ?? 20;
    const raw = this.string('sort') ?? (this.errors.sort ? undefined : xSort.default);
    let sort = parseSort(xSort.default);
    if (raw !== undefined) {
      const m = /^([a-zA-Z]+),(asc|desc)$/.exec(raw);
      if (!m || !xSort.fields.includes(m[1]!)) this.add('sort', 'validation.sort');
      else sort = { field: m[1]!, dir: m[2] as 'asc' | 'desc' };
    }
    return { page, size, sort };
  }

  /** Throws the 400 with every error collected so far. */
  done(): void {
    if (Object.keys(this.errors).length > 0) throw validationProblem(this.errors);
  }
}

/** `YYYY-MM-DD` naming a day that exists (2026-02-30 does not). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toISOString().slice(0, 10) === s;
}

/** The first instant after the UTC day `date` (the exclusive upper bound of an inclusive `to`). */
export const dayAfter = (date: string): Date => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);

function parseSort(s: string): Sort {
  const [field, dir] = s.split(',');
  return { field: field!, dir: dir as 'asc' | 'desc' };
}

/** `ImageVariant` (96 | 480, default 480). */
export function variantParam(req: Request): 96 | 480 {
  const q = new QueryReader(req.query);
  const v = q.enumOf('variant', ['96', '480'] as const);
  q.done();
  return v === '96' ? 96 : 480;
}
