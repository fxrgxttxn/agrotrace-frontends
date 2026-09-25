/**
 * Dictionaries (contracts/openapi/paths/dictionaries.yaml, FR-ADM-02; R51, R54/D29, R82) and the public regions list
 * (public.yaml#listPublicRegions): reading for every authenticated role, writes and product photos for ADMIN.
 * Layout, views and row writes — store.ts; the import — import.ts.
 */
import { sql, type Transaction } from 'kysely';
import type { Request } from 'express';
import {
  IndicatorInputSchema,
  NormInputSchema,
  ProductInputSchema,
  RegionInputSchema,
  SubstanceInputSchema,
} from '@agrotrace/validation';
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { withTx } from '../../db/tx.js';
import type { UploadedFile } from '../../http/multipart.js';
import { QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { RASTER_TYPES } from '../../infra/images.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditRemoval, auditService } from '../audit/service.js';
import { fileAuditView, insertFile, prepareUpload, softDeleteFile, storeObjects } from '../files/service.js';
import { dropPublicPages, productPageCodes } from '../public/cache.js';
import {
  auditView,
  ENTITY_TYPE,
  entryViews,
  insertRow,
  isNamed,
  lockDictionary,
  selectRow,
  SOFT_DELETE,
  updateRow,
  sameValues,
  type Columns,
  type DictName,
  type Q,
  type Row,
} from './store.js';

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const LIST_SORT = { fields: ['name'], default: 'name,asc' } as const;
const CATEGORIES = ['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED'] as const;
const SUBSTANCE_TYPES = ['PESTICIDE', 'FERTILIZER'] as const;

const isAdmin = (p: Principal) => p.roles.includes('ADMIN');

/** The body of `name` (DictionaryInput → the schema of that dictionary) as DB columns. */
function parseInput(name: DictName, body: unknown): Columns {
  switch (name) {
    case 'products': {
      const v = ProductInputSchema.parse(body);
      return {
        name: v.name,
        category: v.category,
        loss_norm_percent: v.lossNormPercent,
        // PUT replaces the whole entry: an absent mercuryCode is null (NullableMercuryCode).
        mercury_code: v.mercuryCode ?? null,
      };
    }
    case 'substances': {
      const v = SubstanceInputSchema.parse(body);
      return { name: v.name, type: v.type, waiting_period_days: v.waitingPeriodDays };
    }
    case 'indicators': {
      const v = IndicatorInputSchema.parse(body);
      return { name: v.name, unit: v.unit };
    }
    case 'norms': {
      const v = NormInputSchema.parse(body);
      return {
        product_id: v.productId.toLowerCase(),
        indicator_id: v.indicatorId.toLowerCase(),
        max_value: v.maxValue,
      };
    }
    case 'regions': {
      const v = RegionInputSchema.parse(body);
      return { code: v.code, name: v.name };
    }
  }
}

export function dictionariesService(c: Container) {
  const { db } = c;

  async function view(name: DictName, row: Row) {
    const [v] = await entryViews(db, name, [row]);
    return v!;
  }

  /** norms: productId/indicatorId must be non-deleted rows → 400 `validation.notFound` on each. */
  async function checkNormRefs(q: Q, cols: Columns) {
    const [p, i] = await Promise.all([
      q
        .selectFrom('products')
        .select('id')
        .where('id', '=', cols.product_id as string)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      q
        .selectFrom('indicators')
        .select('id')
        .where('id', '=', cols.indicator_id as string)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    ]);
    const errors: Record<string, string[]> = {};
    if (!p) errors.productId = ['validation.notFound'];
    if (!i) errors.indicatorId = ['validation.notFound'];
    if (Object.keys(errors).length > 0) throw validationProblem(errors);
  }

  /** The row holding the unique key of `cols` other than `exceptId` (all rows, soft-deleted included). */
  async function keyHolder(tx: Transaction<DB>, name: DictName, cols: Columns, exceptId?: string) {
    const where =
      name === 'norms'
        ? sql`product_id = ${cols.product_id} AND indicator_id = ${cols.indicator_id}`
        : name === 'regions'
          ? sql`code = ${cols.code}`
          : sql`name = ${cols.name}`;
    const r = await sql<Row>`SELECT * FROM ${sql.table(name)} WHERE ${where}
      ${exceptId ? sql`AND id <> ${exceptId}` : sql``} FOR UPDATE`.execute(tx);
    return r.rows[0];
  }

  const duplicate = (name: DictName) =>
    validationProblem({
      [name === 'norms' ? 'indicatorId' : name === 'regions' ? 'code' : 'name']: ['validation.duplicate'],
    });

  return {
    /** listDictionary — filters per dictionary; a filter that does not apply or is not allowed → 400 (R51). */
    async list(p: Principal, name: DictName, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
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
      if (isAdmin(p) && SOFT_DELETE[name]) includeDeleted = q.bool('includeDeleted') ?? false;
      else q.notAllowed('includeDeleted');
      q.done();

      const dir = sort.dir === 'asc' ? sql.raw('ASC') : sql.raw('DESC');
      const conds = [sql`TRUE`];
      let from = sql`${sql.table(name)} t`;
      let order = sql`t.name COLLATE "C" ${dir}`;
      if (SOFT_DELETE[name] && !includeDeleted) conds.push(sql`t.deleted_at IS NULL`);
      if (category) conds.push(sql`t.category = ${category}`);
      if (type) conds.push(sql`t.type = ${type}`);
      if (name === 'norms') {
        from = sql`norms t JOIN products p ON p.id = t.product_id JOIN indicators i ON i.id = t.indicator_id`;
        order = sql`p.name COLLATE "C" ${dir}, i.name COLLATE "C" ${dir}`;
        if (productId) conds.push(sql`t.product_id = ${productId}`);
        if (indicatorId) conds.push(sql`t.indicator_id = ${indicatorId}`);
      }
      if (text !== undefined) {
        // Substring without case; `%`, `_`, `\` are ordinary characters (no LIKE).
        const has = (col: ReturnType<typeof sql>) => sql`position(lower(${text}) in lower(${col})) > 0`;
        if (name === 'norms') conds.push(sql`(${has(sql`p.name`)} OR ${has(sql`i.name`)})`);
        else if (name === 'regions') conds.push(sql`(${has(sql`t.name`)} OR ${has(sql`t.code`)})`);
        else conds.push(has(sql`t.name`));
      }
      const where = sql.join(conds, sql` AND `);
      const count = await sql<{
        total: string;
      }>`SELECT count(*) AS total FROM ${from} WHERE ${where}`.execute(db);
      const rows = await sql<Row>`SELECT t.* FROM ${from} WHERE ${where}
        ORDER BY ${order}, t.id::text COLLATE "C" LIMIT ${size} OFFSET ${(page - 1) * size}`.execute(db);
      return {
        items: await entryViews(db, name, rows.rows),
        page,
        size,
        total: Number(count.rows[0]!.total),
      };
    },

    /**
     * createDictionaryEntry — order: body → norms references (notFound) → uniqueness (duplicate). A name held by a
     * soft-deleted row restores that row with the body's values (201 with its id).
     */
    async create(p: Principal, name: DictName, body: unknown) {
      const cols = parseInput(name, body);
      const row = await withTx(db, async (tx) => {
        await lockDictionary(tx, name);
        if (name === 'norms') await checkNormRefs(tx, cols);
        const held = await keyHolder(tx, name, cols);
        let after: Row;
        let before: Record<string, unknown> | null = null;
        if (held && !(isNamed(name) && held.deleted_at !== null)) throw duplicate(name);
        if (held) {
          before = auditView(name, held);
          after = await updateRow(tx, name, held.id, cols, { restore: true });
        } else after = await insertRow(tx, name, cols);
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createDictionaryEntry',
          entityType: ENTITY_TYPE[name],
          entityId: after.id,
          diff: auditDiff(before, auditView(name, after)),
        });
        return after;
      });
      return view(name, row);
    },

    /**
     * updateDictionaryEntry — order: body → 404 (missing or soft-deleted) → norms references → uniqueness against
     * every other row. Nothing changed → no write, no audit row. A product rename drops its batches' public pages.
     */
    async update(p: Principal, name: DictName, id: string, body: unknown) {
      const cols = parseInput(name, body);
      const { row, codes } = await withTx(db, async (tx) => {
        await lockDictionary(tx, name);
        const current = await selectRow(tx, name, id, true);
        if (!current || (SOFT_DELETE[name] && current.deleted_at !== null))
          throw new AppProblem(404, 'NOT_FOUND');
        if (name === 'norms') await checkNormRefs(tx, cols);
        if (await keyHolder(tx, name, cols, id)) throw duplicate(name);
        if (sameValues(current, cols)) return { row: current, codes: [] as string[] };
        const after = await updateRow(tx, name, id, cols);
        const diff = auditDiff(auditView(name, current), auditView(name, after));
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'updateDictionaryEntry',
          entityType: ENTITY_TYPE[name],
          entityId: id,
          diff,
        });
        const codes = name === 'products' && diff.name ? await productPageCodes(tx, [id]) : [];
        return { row: after, codes };
      });
      await dropPublicPages(c.redis, codes);
      return view(name, row);
    },

    /**
     * deleteDictionaryEntry — soft for products/substances/indicators, hard for norms and regions; a region that an
     * organization or a field (soft-deleted included) refers to → 409 REFERENCE_IN_USE {usedBy}.
     */
    async remove(p: Principal, name: DictName, id: string): Promise<void> {
      await withTx(db, async (tx) => {
        await lockDictionary(tx, name);
        const current = await selectRow(tx, name, id, true);
        if (!current || (SOFT_DELETE[name] && current.deleted_at !== null))
          throw new AppProblem(404, 'NOT_FOUND');
        let diff;
        if (SOFT_DELETE[name]) {
          const now = new Date();
          await sql`UPDATE ${sql.table(name)} SET deleted_at = ${now} WHERE id = ${id}`.execute(tx);
          diff = { deletedAt: [null, now.toISOString()] as [unknown, unknown] };
        } else {
          if (name === 'regions') {
            const used = await sql<{ orgs: boolean; fields: boolean }>`
              SELECT EXISTS (SELECT 1 FROM organizations WHERE region_id = ${id}) AS orgs,
                     EXISTS (SELECT 1 FROM fields WHERE region_id = ${id}) AS fields`.execute(tx);
            const usedBy = [
              ...(used.rows[0]!.orgs ? ['organizations'] : []),
              ...(used.rows[0]!.fields ? ['fields'] : []),
            ];
            if (usedBy.length > 0) throw new AppProblem(409, 'REFERENCE_IN_USE', { params: { usedBy } });
          }
          await sql`DELETE FROM ${sql.table(name)} WHERE id = ${id}`.execute(tx);
          diff = auditRemoval(auditView(name, current));
        }
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'deleteDictionaryEntry',
          entityType: ENTITY_TYPE[name],
          entityId: id,
          diff,
        });
      });
    },

    /**
     * uploadProductImage — after the form (400) and the size (413): 404 for a missing or soft-deleted product, then
     * the type (415, JPEG/PNG/WebP by signature). The previous photo is soft-deleted; the product's public pages are
     * dropped (R82).
     */
    async uploadImage(p: Principal, id: string, upload: UploadedFile) {
      const exists = await db
        .selectFrom('products')
        .select('id')
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!exists) throw new AppProblem(404, 'NOT_FOUND');
      const file = await prepareUpload(upload, {
        kind: 'PRODUCT_IMAGE',
        ownerId: p.userId,
        bucket: c.s3.bucket,
        allowed: RASTER_TYPES,
      });
      await storeObjects(c.s3, file);
      const { row, codes } = await withTx(db, async (tx) => {
        const current = await selectRow(tx, 'products', id, true);
        if (!current || current.deleted_at !== null) throw new AppProblem(404, 'NOT_FOUND');
        const now = new Date();
        await insertFile(tx, file);
        const after = await updateRow(tx, 'products', id, { image_file_id: file.row.id });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadProductImage',
          entityType: 'file',
          entityId: file.row.id,
          diff: auditDiff(null, fileAuditView(file.row)),
        });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadProductImage',
          entityType: 'product',
          entityId: id,
          diff: { imageFileId: [current.image_file_id ?? null, file.row.id] },
        });
        const old = (current.image_file_id as string | null) ?? null;
        if (await softDeleteFile(tx, old, now))
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'uploadProductImage',
            entityType: 'file',
            entityId: old,
            diff: { deletedAt: [null, now.toISOString()] },
          });
        return { row: after, codes: await productPageCodes(tx, [id]) };
      });
      await dropPublicPages(c.redis, codes);
      return view('products', row);
    },

    /** listPublicRegions — every region by name (code points), then code; no paging. */
    async publicRegions() {
      const rows = await db
        .selectFrom('regions')
        .select(['code', 'name'])
        .orderBy(sql`name COLLATE "C"`)
        .orderBy(sql`code COLLATE "C"`)
        .execute();
      return rows.map((r) => ({ code: r.code, name: r.name }));
    },
  };
}
