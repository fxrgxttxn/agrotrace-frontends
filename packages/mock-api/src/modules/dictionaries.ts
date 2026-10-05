import { compareDecimalStrings } from '@agrotrace/domain';
import {
  codePointLength,
  IndicatorInputSchema,
  NormInputSchema,
  ProductInputSchema,
  RegionInputSchema,
  SubstanceInputSchema,
} from '@agrotrace/validation';
import { insertBytesFile, softDeleteFile } from '../domain/files.js';
import { RASTER_TYPES, readFilePart, readUpload } from '../domain/uploads.js';
import { parseBody } from '../http/body.js';
import { json, noContent, type Ctx, type Handler } from '../http/context.js';
import { paginate, uuidParam } from '../http/params.js';
import { ApiError, notFound, validation } from '../http/problem.js';
import { compareValues, contains, sortBy } from '../lib/sort.js';
import { INVALID, isWorkbook, isZip, readXlsx, WorkbookTooLarge, type Cell } from '../lib/xlsx.js';
import type { Mock } from '../runtime.js';
import { auditRemoval, auditView } from '../store/store.js';
import type { IndicatorRow, NormRow, ProductRow, RegionRow, SubstanceRow } from '../store/types.js';
import { logoUrl } from '../views/refs.js';
import { dec6 } from './lab.js';

export const DICT_NAMES = ['products', 'substances', 'indicators', 'norms', 'regions'] as const;
type DictName = (typeof DICT_NAMES)[number];
type AnyRow = ProductRow | SubstanceRow | IndicatorRow | NormRow | RegionRow;
const SOFT: Record<DictName, boolean> = { products: true, substances: true, indicators: true, norms: false, regions: false };
const ENTITY: Record<DictName, string> = { products: 'product', substances: 'substance', indicators: 'indicator', norms: 'norm', regions: 'region' };
const CATEGORIES = ['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED'] as const;
const SUBSTANCE_TYPES = ['PESTICIDE', 'FERTILIZER'] as const;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DATA_ROWS = 10_000;
const IMPORT_TYPES = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

function dictName(ctx: Ctx): DictName {
  const n = ctx.params.name ?? '';
  if (!(DICT_NAMES as readonly string[]).includes(n)) throw validation({ name: ['validation.enum'] });
  return n as DictName;
}

const table = (m: Mock, name: DictName): AnyRow[] => m.store.t[name] as AnyRow[];

export function entryView(m: Mock, name: DictName, r: AnyRow): Record<string, unknown> {
  switch (name) {
    case 'products': {
      const p = r as ProductRow;
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        lossNormPercent: p.loss_norm_percent,
        mercuryCode: p.mercury_code,
        imageUrl: logoUrl(m, p.image_file_id),
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        deletedAt: p.deleted_at,
      };
    }
    case 'substances': {
      const s = r as SubstanceRow;
      return { id: s.id, name: s.name, type: s.type, waitingPeriodDays: s.waiting_period_days, createdAt: s.created_at, updatedAt: s.updated_at, deletedAt: s.deleted_at };
    }
    case 'indicators': {
      const i = r as IndicatorRow;
      return { id: i.id, name: i.name, unit: i.unit, createdAt: i.created_at, updatedAt: i.updated_at, deletedAt: i.deleted_at };
    }
    case 'norms': {
      const n = r as NormRow;
      const p = m.store.must('products', n.product_id);
      const i = m.store.must('indicators', n.indicator_id);
      return {
        id: n.id,
        product: { id: p.id, name: p.name },
        indicator: { id: i.id, name: i.name, unit: i.unit },
        maxValue: dec6(n.max_value),
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      };
    }
    case 'regions': {
      const g = r as RegionRow;
      return { id: g.id, code: g.code, name: g.name };
    }
  }
}

type Columns = Record<string, string | number | null>;

function parseInput(name: DictName, body: unknown): Columns {
  switch (name) {
    case 'products': {
      const v = parseBody(ProductInputSchema, body);
      return { name: v.name, category: v.category, loss_norm_percent: v.lossNormPercent, mercury_code: v.mercuryCode ?? null };
    }
    case 'substances': {
      const v = parseBody(SubstanceInputSchema, body);
      return { name: v.name, type: v.type, waiting_period_days: v.waitingPeriodDays };
    }
    case 'indicators': {
      const v = parseBody(IndicatorInputSchema, body);
      return { name: v.name, unit: v.unit };
    }
    case 'norms': {
      const v = parseBody(NormInputSchema, body);
      return { product_id: v.productId.toLowerCase(), indicator_id: v.indicatorId.toLowerCase(), max_value: v.maxValue };
    }
    case 'regions': {
      const v = parseBody(RegionInputSchema, body);
      return { code: v.code, name: v.name };
    }
  }
}

const keyOf = (name: DictName, c: Columns | AnyRow): string => {
  const x = c as Record<string, unknown>;
  return name === 'norms' ? `${x.product_id}|${x.indicator_id}` : String(name === 'regions' ? x.code : x.name);
};

const DECIMAL_COLS = new Set(['loss_norm_percent', 'max_value']);
const sameValues = (row: AnyRow, cols: Columns): boolean =>
  Object.entries(cols).every(([k, v]) => {
    const cur = (row as unknown as Record<string, unknown>)[k];
    if (DECIMAL_COLS.has(k) && cur !== null && v !== null) return compareDecimalStrings(String(cur), String(v)) === 0;
    return cur === v;
  });

function checkNormRefs(m: Mock, cols: Columns): void {
  const errors: Record<string, string[]> = {};
  const p = m.store.get('products', cols.product_id as string);
  const i = m.store.get('indicators', cols.indicator_id as string);
  if (!p || p.deleted_at !== null) errors.productId = ['validation.notFound'];
  if (!i || i.deleted_at !== null) errors.indicatorId = ['validation.notFound'];
  if (Object.keys(errors).length > 0) throw validation(errors);
}

const duplicate = (name: DictName) =>
  validation({ [name === 'norms' ? 'indicatorId' : name === 'regions' ? 'code' : 'name']: ['validation.duplicate'] });

function writeRow(m: Mock, name: DictName, row: AnyRow, cols: Columns, restore = false): void {
  m.store.touch(ENTITY[name], row);
  const patch: Record<string, unknown> = { ...cols };
  if (name !== 'regions') patch.updated_at = m.store.nowIso();
  if (restore) patch.deleted_at = null;
  m.store.patch(row, patch as Partial<AnyRow>);
}

function insertRow(m: Mock, name: DictName, cols: Columns): AnyRow {
  const now = m.store.nowIso();
  const base: Record<string, unknown> = { id: m.store.id(ENTITY[name]), ...cols };
  if (name !== 'regions') Object.assign(base, { created_at: now, updated_at: now });
  if (SOFT[name]) base.deleted_at = null;
  if (name === 'products') base.image_file_id = null;
  const row = base as unknown as AnyRow;
  (m.store.insert as (t: string, r: AnyRow) => AnyRow)(name, row);
  m.store.created(ENTITY[name], row);
  return row;
}

function parseCsv(text: string): string[][] {
  const bad = () => validation({ file: ['validation.import.format'] });
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return records;
  for (;;) {
    let value: string;
    if (text[i] === '"') {
      let out = '';
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) throw bad();
        out += text.slice(j, q);
        if (text[q + 1] === '"') {
          out += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      value = out;
      i = j;
      if (i < n && text[i] !== ';' && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) throw bad();
    } else {
      let j = i;
      while (j < n && text[j] !== ';' && text[j] !== '\n' && !(text[j] === '\r' && text[j + 1] === '\n')) j++;
      value = text.slice(i, j);
      i = j;
    }
    record.push(value);
    if (i >= n) {
      records.push(record);
      return records;
    }
    if (text[i] === ';') {
      i += 1;
      continue;
    }
    i += text[i] === '\r' ? 2 : 1;
    records.push(record);
    record = [];
    if (i >= n) return records;
  }
}

function readSheet(bytes: Uint8Array): { header: Cell[] | null; rows: { number: number; cells: Cell[] }[]; padShort: boolean } {
  const unsupported = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: IMPORT_TYPES } });
  const tooMany = () => validation({ file: ['validation.import.tooManyRows'] });
  if (isZip(bytes)) {
    let sheet;
    try {
      if (!isWorkbook(bytes)) throw unsupported();
      sheet = readXlsx(bytes);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof WorkbookTooLarge)
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: IMPORT_TYPES, reason: 'workbook-too-large' } });
      throw unsupported();
    }
    const rows = sheet.rows.filter((r) => r.cells.some((c) => c !== ''));
    if (rows.length > MAX_DATA_ROWS) throw tooMany();
    return { header: sheet.header, rows, padShort: true };
  }
  if (bytes.includes(0)) throw unsupported();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw validation({ file: ['validation.import.format'] });
  }
  const records = parseCsv(text);
  const rows: { number: number; cells: Cell[] }[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]!;
    if (cells.every((c) => c === '')) continue;
    if (rows.length === MAX_DATA_ROWS) throw tooMany();
    rows.push({ number: i + 1, cells });
  }
  return { header: records[0] ?? null, rows, padShort: false };
}

const IMPORT_COLUMNS: Record<DictName, string[]> = {
  products: ['name', 'category', 'lossNormPercent'],
  substances: ['name', 'type', 'waitingPeriodDays'],
  indicators: ['name', 'unit'],
  norms: ['product', 'indicator', 'maxValue'],
  regions: ['code', 'name'],
};
const KEY_COLUMN: Record<DictName, string> = { products: 'name', substances: 'name', indicators: 'name', norms: 'indicator', regions: 'code' };

type Rule = (v: string) => string | null;
const text = (max: number): Rule => (v) =>
  v === '' ? 'validation.required' : codePointLength(v) > max ? 'validation.maxLength' : /\S/.test(v) ? null : 'validation.pattern';
const oneOf = (values: readonly string[]): Rule => (v) => (v === '' ? 'validation.required' : values.includes(v) ? null : 'validation.enum');
const numberRule = (pattern: RegExp, max: string): Rule => (v) =>
  v === '' ? 'validation.required' : !pattern.test(v) ? 'validation.pattern' : compareDecimalStrings(v, max) > 0 ? 'validation.max' : null;
const matching = (pattern: RegExp): Rule => (v) => (v === '' ? 'validation.required' : pattern.test(v) ? null : 'validation.pattern');
const RULES: Record<DictName, Rule[]> = {
  products: [text(160), oneOf(CATEGORIES), numberRule(/^\d{1,3}(\.\d{1,2})?$/, '100')],
  substances: [text(160), oneOf(SUBSTANCE_TYPES), numberRule(/^\d{1,4}$/, '3650')],
  indicators: [text(160), text(24)],
  norms: [text(160), text(160), matching(/^\d{1,8}(\.\d{1,6})?$/)],
  regions: [matching(/^[0-9A-Z-]{1,8}$/), text(120)],
};

const pct2 = (v: string): string => {
  const [i, f = ''] = v.split('.');
  return `${Number(i)}.${f.padEnd(2, '0')}`;
};

export const dictionariesHandlers: Record<string, Handler> = {
  listDictionary(ctx) {
    const p = ctx.user();
    const name = dictName(ctx);
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['name'], default: 'name,asc' });
    const needle = q.q();
    let category: string | undefined;
    let type: string | undefined;
    let productId: string | undefined;
    let indicatorId: string | undefined;
    let includeDeleted = false;
    if (name === 'products') category = q.enumOf('category', CATEGORIES);
    else q.notAllowed('category');
    if (name === 'substances') type = q.enumOf('type', SUBSTANCE_TYPES);
    else q.notAllowed('type');
    if (name === 'norms') {
      productId = q.uuid('productId');
      indicatorId = q.uuid('indicatorId');
    } else {
      q.notAllowed('productId');
      q.notAllowed('indicatorId');
    }
    if (p.roles.includes('ADMIN') && SOFT[name]) includeDeleted = q.bool('includeDeleted') ?? false;
    else q.notAllowed('includeDeleted');
    q.done();
    const s = ctx.store;
    let rows = table(ctx, name);
    if (SOFT[name] && !includeDeleted) rows = rows.filter((r) => (r as ProductRow).deleted_at === null);
    if (category) rows = rows.filter((r) => (r as ProductRow).category === category);
    if (type) rows = rows.filter((r) => (r as SubstanceRow).type === type);
    if (productId) rows = rows.filter((r) => (r as NormRow).product_id === productId);
    if (indicatorId) rows = rows.filter((r) => (r as NormRow).indicator_id === indicatorId);
    const normNames = (r: AnyRow) => {
      const n = r as NormRow;
      return [s.must('products', n.product_id).name, s.must('indicators', n.indicator_id).name] as const;
    };
    if (needle !== undefined)
      rows = rows.filter((r) =>
        name === 'norms'
          ? normNames(r).some((x) => contains(x, needle))
          : name === 'regions'
            ? contains((r as RegionRow).name, needle) || contains((r as RegionRow).code, needle)
            : contains((r as ProductRow).name, needle),
      );
    let sorted: AnyRow[];
    if (name === 'norms')
      sorted = [...rows].sort((x, y) => {
        const [px, ix] = normNames(x);
        const [py, iy] = normNames(y);
        const c = compareValues(px, py, 'text') || compareValues(ix, iy, 'text');
        return (sort.dir === 'asc' ? c : -c) || compareValues(x.id, y.id, 'text');
      });
    else sorted = sortBy(rows, (r) => (r as ProductRow).name, 'text', sort.dir);
    const pg = paginate(sorted, page, size);
    return json(200, { ...pg, items: pg.items.map((r) => entryView(ctx, name, r)) });
  },

  async createDictionaryEntry(ctx) {
    const name = dictName(ctx);
    const cols = parseInput(name, await ctx.json());
    if (name === 'norms') checkNormRefs(ctx, cols);
    const held = table(ctx, name).find((r) => keyOf(name, r) === keyOf(name, cols));
    let row: AnyRow;
    if (held) {
      if (!SOFT[name] || (held as ProductRow).deleted_at === null) throw duplicate(name);
      writeRow(ctx, name, held, cols, true);
      row = held;
    } else row = insertRow(ctx, name, cols);
    return json(201, entryView(ctx, name, row));
  },

  async updateDictionaryEntry(ctx) {
    const name = dictName(ctx);
    const id = uuidParam(ctx.params.id);
    const cols = parseInput(name, await ctx.json());
    const row = table(ctx, name).find((r) => r.id === id);
    if (!row || (SOFT[name] && (row as ProductRow).deleted_at !== null)) throw notFound();
    if (name === 'norms') checkNormRefs(ctx, cols);
    if (table(ctx, name).some((r) => r.id !== id && keyOf(name, r) === keyOf(name, cols))) throw duplicate(name);
    if (!sameValues(row, cols)) writeRow(ctx, name, row, cols);
    return json(200, entryView(ctx, name, row));
  },

  deleteDictionaryEntry(ctx) {
    const name = dictName(ctx);
    const id = uuidParam(ctx.params.id);
    const row = table(ctx, name).find((r) => r.id === id);
    if (!row || (SOFT[name] && (row as ProductRow).deleted_at !== null)) throw notFound();
    if (SOFT[name]) {
      ctx.store.touch(ENTITY[name], row);
      ctx.store.patch(row as ProductRow, { deleted_at: ctx.store.nowIso() });
    } else {
      if (name === 'regions') {
        const usedBy = [
          ...(ctx.store.t.organizations.some((o) => o.region_id === id) ? ['organizations'] : []),
          ...(ctx.store.t.fields.some((f) => f.region_id === id) ? ['fields'] : []),
        ];
        if (usedBy.length > 0) throw new ApiError(409, 'REFERENCE_IN_USE', { params: { usedBy } });
      }
      ctx.store.audit({ entityType: ENTITY[name], entityId: id, diff: auditRemoval(auditView(row)) });
      (ctx.store.remove as (t: string, r: AnyRow) => void)(name, row);
    }
    return noContent();
  },

  async importDictionary(ctx) {
    const name = dictName(ctx);
    const file = await readFilePart(ctx, IMPORT_MAX_BYTES);
    const sheet = readSheet(new Uint8Array(await file.arrayBuffer()));
    const columns = IMPORT_COLUMNS[name];
    const header = sheet.header;
    if (!header || header.length !== columns.length || header.some((h, i) => h !== columns[i]))
      throw validation({ file: ['validation.import.header'] });
    const s = ctx.store;
    const report = { created: 0, updated: 0, unchanged: 0, errors: [] as { row: number; column: string | null; message: string }[] };
    const liveProducts = new Map(s.t.products.filter((p) => p.deleted_at === null).map((p) => [p.name, p.id]));
    const liveIndicators = new Map(s.t.indicators.filter((i) => i.deleted_at === null).map((i) => [i.name, i.id]));
    const keys = new Set<string>();
    const valid: Columns[] = [];
    for (const row of sheet.rows) {
      let cells = row.cells;
      if (sheet.padShort && cells.length < columns.length) cells = [...cells, ...Array<Cell>(columns.length - cells.length).fill('')];
      if (cells.length !== columns.length) {
        report.errors.push({ row: row.number, column: null, message: 'validation.import.columns' });
        continue;
      }
      const errs: { col: number; message: string }[] = [];
      cells.forEach((cell, col) => {
        const message = cell === INVALID ? 'validation.pattern' : RULES[name][col]!(cell);
        if (message) errs.push({ col, message });
      });
      if (name === 'norms') {
        const [product, indicator] = cells;
        if (typeof product === 'string' && product !== '' && !errs.some((e) => e.col === 0) && !liveProducts.has(product))
          errs.push({ col: 0, message: 'validation.notFound' });
        if (typeof indicator === 'string' && indicator !== '' && !errs.some((e) => e.col === 1) && !liveIndicators.has(indicator))
          errs.push({ col: 1, message: 'validation.notFound' });
      }
      const keyCells = name === 'norms' ? [cells[0], cells[1]] : [cells[0]];
      if (keyCells.every((k) => typeof k === 'string' && k !== '')) {
        const key = keyCells.join('\u0000');
        if (keys.has(key)) errs.push({ col: columns.indexOf(KEY_COLUMN[name]), message: 'validation.duplicate' });
        else keys.add(key);
      }
      if (errs.length > 0) {
        errs.sort((a, b) => a.col - b.col);
        for (const e of errs) report.errors.push({ row: row.number, column: columns[e.col]!, message: e.message });
        continue;
      }
      const v = cells as string[];
      valid.push(
        name === 'products'
          ? { name: v[0]!, category: v[1]!, loss_norm_percent: pct2(v[2]!) }
          : name === 'substances'
            ? { name: v[0]!, type: v[1]!, waiting_period_days: Number(v[2]) }
            : name === 'indicators'
              ? { name: v[0]!, unit: v[1]! }
              : name === 'norms'
                ? { product_id: liveProducts.get(v[0]!)!, indicator_id: liveIndicators.get(v[1]!)!, max_value: v[2]! }
                : { code: v[0]!, name: v[1]! },
      );
    }
    for (const cols of valid) {
      const current = table(ctx, name).find((r) => keyOf(name, r) === keyOf(name, cols));
      if (!current) {
        insertRow(ctx, name, cols);
        report.created += 1;
        continue;
      }
      const restore = SOFT[name] && (current as ProductRow).deleted_at !== null;
      if (!restore && sameValues(current, cols)) {
        report.unchanged += 1;
        continue;
      }
      writeRow(ctx, name, current, cols, restore);
      report.updated += 1;
    }
    return json(200, report);
  },

  async uploadProductImage(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const product = ctx.store.get('products', id);
    const up = await readUpload(ctx, PRODUCT_IMAGE_MAX_BYTES, RASTER_TYPES, () => {
      if (!product || product.deleted_at !== null) throw notFound();
    });
    const prod = product!;
    const variants = up.variants;
    const file = insertBytesFile(ctx.store, { kind: 'PRODUCT_IMAGE', originalName: up.name, mime: up.mime, data: up.bytes, ownerId: p.userId, ...(variants && { variants }) });
    const old = prod.image_file_id;
    ctx.store.touch('product', prod);
    ctx.store.patch(prod, { image_file_id: file.id, updated_at: ctx.store.nowIso() });
    softDeleteFile(ctx.store, old);
    return json(200, entryView(ctx, 'products', prod));
  },
};
