import type { Schemas } from '@agrotrace/api-client';
import {
  IndicatorInputSchema,
  NormInputSchema,
  ProductInputSchema,
  RegionInputSchema,
  SubstanceInputSchema,
} from '@agrotrace/validation';
import type { ZodTypeAny } from 'zod';
import { cache } from '../../app/cache.svelte';
import { DICTIONARIES, type DictName } from '../../app/admin';
import { normalizeDecimal } from '../../app/forms.svelte';
import type { ListSpec } from '../../app/listState.svelte';

export type Product = Schemas['Product'];
export type Substance = Schemas['Substance'];
export type Indicator = Schemas['Indicator'];
export type Norm = Schemas['Norm'];
export type Region = Schemas['RegionEntry'];
export type Entry = Product | Substance | Indicator | Norm | Region;
export type Report = Schemas['ImportReport'];

export const SIZE = 20;
export const STACK = 'display: grid; gap: var(--sp-4)';
export const CATEGORIES: readonly Schemas['ProductCategory'][] = [
  'GRAIN',
  'VEGETABLE',
  'FRUIT',
  'DAIRY',
  'MEAT',
  'OILSEED',
  'PROCESSED',
];
export const SUBSTANCE_TYPES: readonly Schemas['SubstanceType'][] = ['PESTICIDE', 'FERTILIZER'];
export const SOFT: readonly DictName[] = ['products', 'substances', 'indicators'];

export const SPECS: Record<DictName, ListSpec> = {
  products: {
    sort: ['name'],
    enums: { category: CATEGORIES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  substances: {
    sort: ['name'],
    enums: { type: SUBSTANCE_TYPES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  indicators: { sort: ['name'], patterns: { includeDeleted: /^true$/ }, texts: ['q'] },
  norms: { sort: ['name'], texts: ['q'] },
  regions: { sort: ['name'], texts: ['q'] },
};

export const isDict = (s: string | undefined): s is DictName => DICTIONARIES.includes(s as DictName);

export function entryName(name: DictName, e: Entry): string {
  if (name === 'norms') {
    const n = e as Norm;
    return `${n.product.name} — ${n.indicator.name}`;
  }
  return (e as { name: string }).name;
}

export function refresh(name: DictName): void {
  void cache.invalidate(['dictionaryAdmin', name]);
  void cache.invalidate(['dictionary', name]);
  if (name === 'products' || name === 'indicators') void cache.invalidate(['dictionaryAdmin', 'norms']);
}

export type Values = Record<string, string>;

export interface FormDef {
  fields: string[];
  defaults: (e?: Entry) => Values;
  schema: ZodTypeAny;
  toWire: (v: Values) => Record<string, unknown>;
  precheck?: (v: Values) => Record<string, string>;
}

export const FORMS: Record<DictName, FormDef> = {
  products: {
    fields: ['name', 'category', 'lossNormPercent', 'mercuryCode'],
    defaults: (e) => {
      const p = e as Product | undefined;
      return {
        name: p?.name ?? '',
        category: p?.category ?? '',
        lossNormPercent: p ? p.lossNormPercent.replace('.', ',') : '',
        mercuryCode: p?.mercuryCode ?? '',
      };
    },
    schema: ProductInputSchema,
    toWire: (v) => ({
      name: v.name,
      category: v.category,
      lossNormPercent: normalizeDecimal(v.lossNormPercent!, 2),
      mercuryCode: v.mercuryCode!.trim() === '' ? null : v.mercuryCode!.trim(),
    }),
  },
  substances: {
    fields: ['name', 'type', 'waitingPeriodDays'],
    defaults: (e) => {
      const s = e as Substance | undefined;
      return {
        name: s?.name ?? '',
        type: s?.type ?? '',
        waitingPeriodDays: s ? String(s.waitingPeriodDays) : '',
      };
    },
    schema: SubstanceInputSchema,
    toWire: (v) => ({
      name: v.name,
      type: v.type,
      waitingPeriodDays: /^\d{1,4}$/.test(v.waitingPeriodDays!.trim()) ? Number(v.waitingPeriodDays) : '',
    }),
    precheck: (v): Record<string, string> =>
      v.waitingPeriodDays!.trim() !== '' && !/^\d{1,4}$/.test(v.waitingPeriodDays!.trim())
        ? { waitingPeriodDays: 'validation.pattern' }
        : {},
  },
  indicators: {
    fields: ['name', 'unit'],
    defaults: (e) => ({
      name: (e as Indicator | undefined)?.name ?? '',
      unit: (e as Indicator | undefined)?.unit ?? '',
    }),
    schema: IndicatorInputSchema,
    toWire: (v) => ({ name: v.name, unit: v.unit }),
  },
  norms: {
    fields: ['productId', 'indicatorId', 'maxValue'],
    defaults: (e) => {
      const n = e as Norm | undefined;
      return {
        productId: n?.product.id ?? '',
        indicatorId: n?.indicator.id ?? '',
        maxValue: n ? n.maxValue.replace(/\.?0+$/, '').replace('.', ',') : '',
      };
    },
    schema: NormInputSchema,
    toWire: (v) => ({
      productId: v.productId,
      indicatorId: v.indicatorId,
      maxValue: v.maxValue!.trim().replace(',', '.'),
    }),
  },
  regions: {
    fields: ['code', 'name'],
    defaults: (e) => ({
      code: (e as Region | undefined)?.code ?? '',
      name: (e as Region | undefined)?.name ?? '',
    }),
    schema: RegionInputSchema,
    toWire: (v) => ({ code: v.code!.trim().toUpperCase(), name: v.name }),
  },
};

export const COLUMN_LABEL: Record<string, string> = {
  name: 'field.name',
  category: 'field.category',
  lossNormPercent: 'field.lossNormPercent',
  type: 'field.type',
  waitingPeriodDays: 'field.waitingPeriodDays',
  unit: 'field.unit',
  product: 'field.productId',
  indicator: 'field.indicatorId',
  maxValue: 'field.maxValue',
  code: 'field.code',
};
