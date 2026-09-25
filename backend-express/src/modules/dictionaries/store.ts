/**
 * The five dictionaries of spec 7.2 (contracts/openapi/paths/dictionaries.yaml, R54/D29): table layout, API views,
 * audit views (API names and formats) and the row writes shared by the CRUD operations and the import.
 *
 * products, substances, indicators — soft delete (`deleted_at`), unique `name` among all rows (a soft-deleted row
 * keeps its name and is restored by a create/import with that name); norms — hard delete, unique (product, indicator);
 * regions — hard delete, unique `code`, no timestamps. Every write of a dictionary runs under a transaction-scoped
 * advisory lock of that dictionary (`dictionary:<name>`), taken first in the transaction: the uniqueness checks and
 * the import's lookups then see a stable dictionary, and parallel admin writes never race into a 23505.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import { compareDecimalStrings } from '@agrotrace/domain';
import type { DB } from '../../db/types.generated.js';
import { validationProblem } from '../../http/problem.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import type { AuditEntityType } from '../audit/service.js';

export const DICT_NAMES = ['products', 'substances', 'indicators', 'norms', 'regions'] as const;
export type DictName = (typeof DICT_NAMES)[number];
export type NamedDict = 'products' | 'substances' | 'indicators';

export const SOFT_DELETE: Record<DictName, boolean> = {
  products: true,
  substances: true,
  indicators: true,
  norms: false,
  regions: false,
};
export const ENTITY_TYPE: Record<DictName, AuditEntityType> = {
  products: 'product',
  substances: 'substance',
  indicators: 'indicator',
  norms: 'norm',
  regions: 'region',
};
/** Decimal columns: compared numerically (R59 `unchanged`). */
const DECIMAL_COLUMNS = new Set(['loss_norm_percent', 'max_value']);

export const isNamed = (n: DictName): n is NamedDict => n !== 'norms' && n !== 'regions';

export type Q = Kysely<DB> | Transaction<DB>;
export type Row = Record<string, unknown> & { id: string };
/** Column values of a write (DB names). */
export type Columns = Record<string, string | number | null>;

/** `DictionaryName` path parameter → 400 `errors.name: [validation.enum]` for any other value. */
export function dictNameParam(req: Request): DictName {
  const v = req.params.name;
  if (!(DICT_NAMES as readonly string[]).includes(v ?? ''))
    throw validationProblem({ name: ['validation.enum'] });
  return v as DictName;
}

/** Serializes the writes of one dictionary (taken first in every writing transaction). */
export async function lockDictionary(tx: Transaction<DB>, name: DictName): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`dictionary:${name}`}))`.execute(tx);
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as Date).toISOString();

/** Audit view of a row: API field names and formats (AuditEntry: decimals as strings, dates ISO, files by id). */
export function auditView(name: DictName, r: Row): Record<string, unknown> {
  switch (name) {
    case 'products':
      return {
        name: r.name,
        category: r.category,
        lossNormPercent: r.loss_norm_percent,
        mercuryCode: r.mercury_code,
        imageFileId: r.image_file_id,
        deletedAt: iso(r.deleted_at),
      };
    case 'substances':
      return {
        name: r.name,
        type: r.type,
        waitingPeriodDays: r.waiting_period_days,
        deletedAt: iso(r.deleted_at),
      };
    case 'indicators':
      return { name: r.name, unit: r.unit, deletedAt: iso(r.deleted_at) };
    case 'norms':
      return { productId: r.product_id, indicatorId: r.indicator_id, maxValue: r.max_value };
    case 'regions':
      return { code: r.code, name: r.name };
  }
}

/** API views (`DictionaryEntry`) of rows of one dictionary, in the given order. */
export async function entryViews(q: Q, name: DictName, rows: Row[]): Promise<Record<string, unknown>[]> {
  switch (name) {
    case 'products':
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        lossNormPercent: r.loss_norm_percent,
        mercuryCode: r.mercury_code,
        imageUrl: r.image_file_id ? publicFileUrl(r.image_file_id as string) : null,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        deletedAt: iso(r.deleted_at),
      }));
    case 'substances':
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        waitingPeriodDays: r.waiting_period_days,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        deletedAt: iso(r.deleted_at),
      }));
    case 'indicators':
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        deletedAt: iso(r.deleted_at),
      }));
    case 'regions':
      return rows.map((r) => ({ id: r.id, code: r.code, name: r.name }));
    case 'norms': {
      if (rows.length === 0) return [];
      const refs = await q
        .selectFrom('norms as n')
        .innerJoin('products as p', 'p.id', 'n.product_id')
        .innerJoin('indicators as i', 'i.id', 'n.indicator_id')
        .select(['n.id', 'p.name as product_name', 'i.name as indicator_name', 'i.unit as indicator_unit'])
        .where(
          'n.id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      const byId = new Map(refs.map((x) => [x.id, x]));
      return rows.map((r) => {
        const ref = byId.get(r.id)!;
        return {
          id: r.id,
          product: { id: r.product_id, name: ref.product_name },
          indicator: { id: r.indicator_id, name: ref.indicator_name, unit: ref.indicator_unit },
          maxValue: r.max_value,
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
        };
      });
    }
  }
}

export async function selectRow(
  q: Q,
  name: DictName,
  id: string,
  forUpdate = false,
): Promise<Row | undefined> {
  const r =
    await sql<Row>`SELECT * FROM ${sql.table(name)} WHERE id = ${id}${forUpdate ? sql` FOR UPDATE` : sql``}`.execute(
      q,
    );
  return r.rows[0];
}

export async function insertRow(tx: Transaction<DB>, name: DictName, cols: Columns): Promise<Row> {
  const keys = Object.keys(cols);
  const r = await sql<Row>`
    INSERT INTO ${sql.table(name)} (${sql.join(keys.map((k) => sql.id(k)))})
    VALUES (${sql.join(keys.map((k) => sql`${cols[k]}`))})
    RETURNING *`.execute(tx);
  return r.rows[0]!;
}

/** Writes `cols` (plus `updated_at`, except regions — no timestamps; `restore` clears `deleted_at`). */
export async function updateRow(
  tx: Transaction<DB>,
  name: DictName,
  id: string,
  cols: Columns,
  opts: { restore?: boolean } = {},
): Promise<Row> {
  const sets = Object.entries(cols).map(([k, v]) => sql`${sql.id(k)} = ${v}`);
  if (name !== 'regions') sets.push(sql`updated_at = now()`);
  if (opts.restore) sets.push(sql`deleted_at = NULL`);
  const r = await sql<Row>`
    UPDATE ${sql.table(name)} SET ${sql.join(sets)} WHERE id = ${id} RETURNING *`.execute(tx);
  return r.rows[0]!;
}

/** Whether the row already holds these values (decimals compared numerically — `5` = `5.00`, R59). */
export function sameValues(row: Row, cols: Columns): boolean {
  return Object.entries(cols).every(([k, v]) => {
    const cur = row[k];
    if (DECIMAL_COLUMNS.has(k) && cur !== null && v !== null)
      return compareDecimalStrings(String(cur), String(v)) === 0;
    return cur === v;
  });
}
