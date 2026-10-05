import { readFileSync } from 'node:fs';

export type OrgType = 'FARM' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'AUTHORITY' | 'PLATFORM';
export type RoleCode = 'FARMER' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'INSPECTOR' | 'ADMIN';

export interface OrgData {
  key: string;
  type: OrgType;
  name: string;
  inn: string;
  regionCode: string;
  address: string;
}
export interface UserData {
  key: string;
  org: string;
  email: string;
  fullName: string;
  phone: string;
  roles: RoleCode[];
  isOrgAdmin: boolean;
  avatar?: string;
}
export interface ProductData {
  key: string;
  name: string;
  category: 'GRAIN' | 'VEGETABLE' | 'FRUIT' | 'DAIRY' | 'MEAT' | 'OILSEED' | 'PROCESSED';
  lossNormPercent: string;
  mercuryCode?: string;
  image: string;
}
export interface SubstanceData {
  key: string;
  name: string;
  type: 'PESTICIDE' | 'FERTILIZER';
  waitingPeriodDays: number;
}
export interface IndicatorData {
  key: string;
  name: string;
  unit: string;
}
export interface FieldData {
  key: string;
  org: string;
  name: string;
  regionCode: string;
  areaHa: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}
export type NormsData = Record<string, Record<string, string>>;

export const SEED_ROOT = new URL('..', import.meta.url);

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`data/${name}.json`, SEED_ROOT), 'utf8')) as T;

export interface SeedData {
  organizations: OrgData[];
  users: UserData[];
  products: ProductData[];
  substances: SubstanceData[];
  indicators: IndicatorData[];
  norms: NormsData;
  fields: FieldData[];
}

export function loadData(): SeedData {
  return {
    organizations: load('organizations'),
    users: load('users'),
    products: load('products'),
    substances: load('substances'),
    indicators: load('indicators'),
    norms: load('norms'),
    fields: load('fields'),
  };
}

export const DEMO_PASSWORD = 'agrotrace-demo';
