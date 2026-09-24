import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VetInspection {
  result: 'HEALTHY';
  date: string;
  doctor: string;
}

export interface Product {
  code: string;
  name: string;
}

export interface Volume {
  value: number;
  unit: string;
}

export interface OrgRef {
  inn: string;
  name: string;
}

export type VsdStatus = 'CONFIRMED' | 'WITHDRAWN' | 'UTILIZED';

export interface Vsd {
  uuid: string;
  number: string;
  issueDate: string;
  status: VsdStatus;
  product: Product;
  volume: Volume;
  consignor: OrgRef;
  consignee: OrgRef;
  vetInspection: VetInspection;
}

const DEFAULT_DATA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/vsd.json',
);

/** Loads the VSD dataset from disk (default: mercury-mock/data/vsd.json). */
export function loadVsdList(dataPath: string = DEFAULT_DATA_PATH): Vsd[] {
  const raw = readFileSync(dataPath, 'utf-8');
  return JSON.parse(raw) as Vsd[];
}

export interface VsdFilters {
  productCode?: string;
  senderInn?: string;
  dateFrom?: string;
  dateTo?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** true iff `s` is a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Rejects overflowing components Date silently normalizes, e.g. 2026-02-30.
  return d.toISOString().slice(0, 10) === s;
}

/** Thrown by filterVsdList when a filter value is malformed. */
export class InvalidQueryError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`invalid query parameter: ${field}`);
    this.name = 'InvalidQueryError';
    this.field = field;
  }
}

/**
 * Filters the VSD list. dateFrom/dateTo bounds are inclusive and compared
 * against `issueDate` (both are YYYY-MM-DD, so lexicographic order matches
 * calendar order).
 */
export function filterVsdList(list: Vsd[], filters: VsdFilters): Vsd[] {
  if (filters.dateFrom !== undefined && !isValidIsoDate(filters.dateFrom)) {
    throw new InvalidQueryError('dateFrom');
  }
  if (filters.dateTo !== undefined && !isValidIsoDate(filters.dateTo)) {
    throw new InvalidQueryError('dateTo');
  }

  return list.filter((v) => {
    if (filters.productCode !== undefined && v.product.code !== filters.productCode) return false;
    if (filters.senderInn !== undefined && v.consignor.inn !== filters.senderInn) return false;
    if (filters.dateFrom !== undefined && v.issueDate < filters.dateFrom) return false;
    if (filters.dateTo !== undefined && v.issueDate > filters.dateTo) return false;
    return true;
  });
}

export function findVsdByUuid(list: Vsd[], uuid: string): Vsd | undefined {
  return list.find((v) => v.uuid === uuid);
}
