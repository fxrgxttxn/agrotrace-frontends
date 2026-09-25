/**
 * importDictionary (dictionaries.yaml, FR-ANL-05, R54/D30, R58, R59): the file (sheet.ts) → the header check → row
 * checks in file order → one transaction that creates, updates (restoring soft-deleted rows) or leaves rows as they
 * are, with an audit row per created or updated row → `ImportReport`.
 *
 * Row rules: a row with another number of cells than the header → `{column: null, validation.import.columns}`;
 * values are never trimmed (R36) and follow `DictionaryInput` except the import's own number formats
 * (`lossNormPercent` `^\d{1,3}(\.\d{1,2})?$` ≤ 100, `waitingPeriodDays` `^\d{1,4}$` ≤ 3650, `maxValue` Decimal);
 * `product`/`indicator` name a non-deleted row exactly. The key (`name`, `code`, the `product`+`indicator` pair)
 * belongs to the first row in file order that carries it — even a row with value errors; every later row with the
 * same key → `validation.duplicate` at the key column (`name`, `code`, `indicator`). Rows with errors are skipped.
 * `mercuryCode` is never set by the import (new products — null, existing — kept).
 */
import { sql, type Transaction } from 'kysely';
import { compareDecimalStrings } from '@agrotrace/domain';
import { codePointLength } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { withTx } from '../../db/tx.js';
import { validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { dropPublicPages, productPageCodes } from '../public/cache.js';
import { INVALID, readSheet, type Cell } from './sheet.js';
import {
  auditView,
  ENTITY_TYPE,
  insertRow,
  isNamed,
  lockDictionary,
  sameValues,
  updateRow,
  type Columns,
  type DictName,
  type Row,
} from './store.js';

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export const IMPORT_COLUMNS: Record<DictName, readonly string[]> = {
  products: ['name', 'category', 'lossNormPercent'],
  substances: ['name', 'type', 'waitingPeriodDays'],
  indicators: ['name', 'unit'],
  norms: ['product', 'indicator', 'maxValue'],
  regions: ['code', 'name'],
};
const KEY_COLUMN: Record<DictName, string> = {
  products: 'name',
  substances: 'name',
  indicators: 'name',
  norms: 'indicator',
  regions: 'code',
};

export interface ImportReport {
  created: number;
  updated: number;
  unchanged: number;
  errors: { row: number; column: string | null; message: string }[];
}

type Rule = (v: string) => string | null;

/** A name-like string: required, `maxLength` in code points, not only whitespace (`\S`). */
const text =
  (max: number): Rule =>
  (v) =>
    v === ''
      ? 'validation.required'
      : // Beyond 2·max UTF-16 units the string is too long whatever it holds (no code-point split of a huge cell).
        v.length > 2 * max || codePointLength(v) > max
        ? 'validation.maxLength'
        : /\S/.test(v)
          ? null
          : 'validation.pattern';
const oneOf =
  (values: readonly string[]): Rule =>
  (v) =>
    v === '' ? 'validation.required' : values.includes(v) ? null : 'validation.enum';
const numberRule =
  (pattern: RegExp, max: string): Rule =>
  (v) =>
    v === ''
      ? 'validation.required'
      : !pattern.test(v)
        ? 'validation.pattern'
        : compareDecimalStrings(v, max) > 0
          ? 'validation.max'
          : null;
const matching =
  (pattern: RegExp): Rule =>
  (v) =>
    v === '' ? 'validation.required' : pattern.test(v) ? null : 'validation.pattern';

const RULES: Record<DictName, Rule[]> = {
  products: [
    text(160),
    oneOf(['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED']),
    numberRule(/^\d{1,3}(\.\d{1,2})?$/, '100'),
  ],
  substances: [text(160), oneOf(['PESTICIDE', 'FERTILIZER']), numberRule(/^\d{1,4}$/, '3650')],
  indicators: [text(160), text(24)],
  // product / indicator: exact names, looked up below.
  norms: [text(160), text(160), matching(/^\d{1,8}(\.\d{1,6})?$/)],
  regions: [matching(/^[0-9A-Z-]{1,8}$/), text(120)],
};

interface ValidRow {
  number: number;
  key: string;
  cols: Columns;
}

/** Columns of a checked row. */
function columnsOf(
  name: DictName,
  v: string[],
  refs: { products: Map<string, string>; indicators: Map<string, string> },
): Columns {
  switch (name) {
    case 'products':
      return { name: v[0]!, category: v[1]!, loss_norm_percent: v[2]! };
    case 'substances':
      return { name: v[0]!, type: v[1]!, waiting_period_days: Number(v[2]) };
    case 'indicators':
      return { name: v[0]!, unit: v[1]! };
    case 'norms':
      return {
        product_id: refs.products.get(v[0]!)!,
        indicator_id: refs.indicators.get(v[1]!)!,
        max_value: v[2]!,
      };
    case 'regions':
      return { code: v[0]!, name: v[1]! };
  }
}

const rowKey = (name: DictName, cols: Columns): string =>
  name === 'norms'
    ? `${cols.product_id}|${cols.indicator_id}`
    : String(name === 'regions' ? cols.code : cols.name);

/** The existing rows (soft-deleted included) holding the keys of `rows`, locked, by key. */
async function existingRows(
  tx: Transaction<DB>,
  name: DictName,
  rows: ValidRow[],
): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000).map((r) => r.cols);
    let found: Row[];
    if (name === 'norms') {
      const r = await sql<Row>`
        SELECT n.* FROM norms n
          JOIN unnest(${chunk.map((c) => c.product_id)}::uuid[], ${chunk.map((c) => c.indicator_id)}::uuid[])
               AS k(product_id, indicator_id)
            ON k.product_id = n.product_id AND k.indicator_id = n.indicator_id
         FOR NO KEY UPDATE OF n`.execute(tx);
      found = r.rows;
    } else {
      const column = name === 'regions' ? 'code' : 'name';
      const r = await sql<Row>`SELECT * FROM ${sql.table(name)}
        WHERE ${sql.id(column)} = ANY(${chunk.map((c) => c[column] as string)}::text[]) FOR NO KEY UPDATE`.execute(
        tx,
      );
      found = r.rows;
    }
    for (const row of found) out.set(rowKey(name, row as unknown as Columns), row);
  }
  return out;
}

/** Non-deleted products and indicators by exact name (norms import), FOR SHARE — no parallel soft delete (P23). */
async function referenceMaps(tx: Transaction<DB>) {
  const [products, indicators] = await Promise.all([
    tx.selectFrom('products').select(['id', 'name']).where('deleted_at', 'is', null).forShare().execute(),
    tx.selectFrom('indicators').select(['id', 'name']).where('deleted_at', 'is', null).forShare().execute(),
  ]);
  return {
    products: new Map(products.map((r) => [r.name, r.id])),
    indicators: new Map(indicators.map((r) => [r.name, r.id])),
  };
}

export async function importDictionary(
  c: Container,
  p: Principal,
  name: DictName,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ImportReport> {
  const sheet = await readSheet(bytes, { signal });
  const columns = IMPORT_COLUMNS[name];
  const header = sheet.header;
  if (!header || header.length !== columns.length || header.some((h, i) => h !== columns[i]))
    throw validationProblem({ file: ['validation.import.header'] });

  const { report, codes } = await withTx(c.db, async (tx) => {
    await lockDictionary(tx, name);
    const report: ImportReport = { created: 0, updated: 0, unchanged: 0, errors: [] };
    const refs =
      name === 'norms'
        ? await referenceMaps(tx)
        : { products: new Map<string, string>(), indicators: new Map<string, string>() };
    const keys = new Set<string>();
    const valid: ValidRow[] = [];

    for (const row of sheet.rows) {
      let cells: Cell[] = row.cells;
      if (sheet.padShort && cells.length < columns.length)
        cells = [...cells, ...Array<Cell>(columns.length - cells.length).fill('')];
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
        if (
          typeof product === 'string' &&
          product !== '' &&
          !errs.some((e) => e.col === 0) &&
          !refs.products.has(product)
        )
          errs.push({ col: 0, message: 'validation.notFound' });
        if (
          typeof indicator === 'string' &&
          indicator !== '' &&
          !errs.some((e) => e.col === 1) &&
          !refs.indicators.has(indicator)
        )
          errs.push({ col: 1, message: 'validation.notFound' });
      }
      // The key belongs to the first row that carries it (non-empty text key cells), errors or not (R59).
      const keyCells = name === 'norms' ? [cells[0], cells[1]] : [cells[0]];
      if (keyCells.every((k) => typeof k === 'string' && k !== '')) {
        const key = keyCells.join('\u0000');
        if (keys.has(key))
          errs.push({ col: columns.indexOf(KEY_COLUMN[name]), message: 'validation.duplicate' });
        else keys.add(key);
      }
      if (errs.length > 0) {
        errs.sort((a, b) => a.col - b.col);
        for (const e of errs)
          report.errors.push({ row: row.number, column: columns[e.col]!, message: e.message });
        continue;
      }
      const values = cells as string[];
      const cols = columnsOf(name, values, refs);
      valid.push({ number: row.number, key: rowKey(name, cols), cols });
    }

    const existing = await existingRows(tx, name, valid);
    const changedProducts: string[] = [];
    for (const v of valid) {
      const current = existing.get(v.key);
      let before: Record<string, unknown> | null = null;
      let after: Row;
      if (!current) {
        after = await insertRow(tx, name, v.cols);
        report.created += 1;
      } else {
        const restore = isNamed(name) && current.deleted_at !== null;
        if (!restore && sameValues(current, v.cols)) {
          report.unchanged += 1;
          continue;
        }
        before = auditView(name, current);
        after = await updateRow(tx, name, current.id, v.cols, { restore });
        report.updated += 1;
        if (name === 'products') changedProducts.push(current.id);
      }
      await auditService.record(tx, {
        actorId: p.userId,
        action: 'importDictionary',
        entityType: ENTITY_TYPE[name],
        entityId: after.id,
        diff: auditDiff(before, auditView(name, after)),
      });
    }
    return { report, codes: await productPageCodes(tx, changedProducts) };
  });
  await dropPublicPages(c.redis, codes);
  return report;
}
