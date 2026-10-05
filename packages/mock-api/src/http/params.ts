import { codePointLength } from '@agrotrace/validation';
import { validation } from './problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export type Sort = { field: string; dir: 'asc' | 'desc' };

export class QueryReader {
  readonly errors: Record<string, string[]> = {};

  constructor(private readonly query: URLSearchParams) {}

  private add(name: string, key: string): undefined {
    (this.errors[name] ??= []).push(key);
    return undefined;
  }

  has(name: string): boolean {
    return this.query.has(name);
  }

  string(name: string): string | undefined {
    const all = this.query.getAll(name);
    if (all.length === 0) return undefined;
    if (all.length > 1) return this.add(name, 'validation.type');
    return all[0];
  }

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

  enumList<T extends string>(name: string, values: readonly T[]): T[] | undefined {
    const list = this.query.getAll(name);
    if (list.length === 0) return undefined;
    if (list.some((x) => !(values as readonly string[]).includes(x))) return this.add(name, 'validation.enum');
    if (new Set(list).size !== list.length) return this.add(name, 'validation.duplicate');
    return list as T[];
  }

  uuid(name: string): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!isUuid(s)) return this.add(name, 'validation.uuid');
    return s.toLowerCase();
  }

  q(name = 'q'): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    const len = codePointLength(s);
    if (len < 1) return this.add(name, 'validation.minLength');
    if (len > 100) return this.add(name, 'validation.maxLength');
    return s;
  }

  text(name: string, maxLength: number): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (codePointLength(s) > maxLength) return this.add(name, 'validation.maxLength');
    return s;
  }

  matching(name: string, pattern: RegExp): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!pattern.test(s)) return this.add(name, 'validation.pattern');
    return s;
  }

  bool(name: string): boolean | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (s !== 'true' && s !== 'false') return this.add(name, 'validation.type');
    return s === 'true';
  }

  date(name: string): string | undefined {
    const s = this.string(name);
    if (s === undefined) return undefined;
    if (!isCalendarDate(s)) return this.add(name, 'validation.date.format');
    return s;
  }

  dateRange(): { from?: string; to?: string } {
    const from = this.date('from');
    const to = this.date('to');
    if (from !== undefined && to !== undefined && from > to) this.add('from', 'validation.range');
    return { from, to };
  }

  notAllowed(name: string): void {
    if (this.has(name)) this.errors[name] = [`validation.${name}.notAllowed`];
  }

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

  done(): void {
    if (Object.keys(this.errors).length > 0) throw validation(this.errors);
  }
}

export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toISOString().slice(0, 10) === s;
}

export const dayStartMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);
export const dayAfterMs = (date: string): number => dayStartMs(date) + 86_400_000;

export function inDateRange(range: { from?: string; to?: string }, t: string | null | undefined): boolean {
  if (range.from === undefined && range.to === undefined) return true;
  if (!t) return false;
  const x = Date.parse(t);
  if (range.from !== undefined && x < dayStartMs(range.from)) return false;
  if (range.to !== undefined && x >= dayAfterMs(range.to)) return false;
  return true;
}

function parseSort(s: string): Sort {
  const [field, dir] = s.split(',');
  return { field: field!, dir: dir as 'asc' | 'desc' };
}

export function uuidParam(value: string | undefined, name = 'id'): string {
  if (!isUuid(value)) throw validation({ [name]: ['validation.uuid'] });
  return value.toLowerCase();
}

export function paginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; size: number; total: number } {
  return { items: items.slice((page - 1) * size, page * size), page, size, total: items.length };
}
