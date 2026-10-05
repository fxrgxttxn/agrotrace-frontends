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

export const MOCK_REFERENCE_NOW = '2026-09-20T09:00:00Z';

const DAY = 86_400_000;
const utcDay = (t: number): number => Math.floor(t / DAY);

export function shiftDays(now: number): number {
  return utcDay(now) - utcDay(Date.parse(MOCK_REFERENCE_NOW));
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function shiftVsdDates(list: readonly Vsd[], now: number): Vsd[] {
  const d = shiftDays(now);
  return list.map((v) => ({
    ...v,
    issueDate: addDays(v.issueDate, d),
    vetInspection: { ...v.vetInspection, date: addDays(v.vetInspection.date, d) },
  }));
}
