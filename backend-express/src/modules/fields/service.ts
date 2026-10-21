/**
 * Fields and treatments (contracts/openapi/paths/fields.yaml, treatments.yaml; FR-PROD-01/02, R41/D1, R51).
 *
 * Visibility (tag Fields): FARMER — the non-deleted fields of the own farm, the only ones it may change; INSPECTOR
 * and ADMIN — every non-deleted field, read-only. A treatment is visible with its field. Anything outside that is
 * indistinguishable from a missing entity (404). A treatment may be changed while the server time ≤ createdAt + 24 h
 * (`canEditTreatment`, inclusive), otherwise 403 FORBIDDEN {reason: EDIT_WINDOW_CLOSED, editableUntil}.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import { canEditTreatment } from '@agrotrace/domain';
import {
  FieldInputSchema,
  toFieldErrors,
  TreatmentInputSchema,
  type FieldInput,
} from '@agrotrace/validation';
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { txNow, withTx } from '../../db/tx.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { REGION_CODE } from '../admin/service.js';

const FIELD_SORT = {
  fields: ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'],
  default: 'name,asc',
} as const;
const TREATMENT_SORT = { fields: ['appliedAt', 'createdAt'], default: 'appliedAt,desc' } as const;
const DAY_MS = 24 * 3600 * 1000;
const RING_NOT_CLOSED = 'validation.geometry.ringNotClosed';

type Q = Kysely<DB> | Transaction<DB>;

const seesAll = (p: Principal) => p.roles.includes('INSPECTOR') || p.roles.includes('ADMIN');
const iso = (v: unknown): string => new Date(v as Date).toISOString();

/**
 * FieldInput by the shared schema; the contract reports an open ring at `errors.geometry` (not at the ring's own
 * path), other geometry errors keep their paths (`geometry.coordinates[0]`, …).
 */
function parseFieldInput(body: unknown): FieldInput {
  const r = FieldInputSchema.safeParse(body);
  if (r.success) return r.data;
  const errors = toFieldErrors(r.error);
  for (const [path, keys] of Object.entries(errors)) {
    if (path === 'geometry' || !path.startsWith('geometry') || !keys.includes(RING_NOT_CLOSED)) continue;
    const rest = keys.filter((k) => k !== RING_NOT_CLOSED);
    if (rest.length > 0) errors[path] = rest;
    else delete errors[path];
    const at = (errors.geometry ??= []);
    if (!at.includes(RING_NOT_CLOSED)) at.push(RING_NOT_CLOSED);
  }
  throw validationProblem(errors);
}

export interface FieldView {
  id: string;
  name: string;
  areaHa: string;
  region: { code: string; name: string };
  geometry: unknown;
  lastTreatmentAt: string | null;
  treatmentsCount: number;
  organization: { id: string; name: string; type: string; logoUrl: string | null };
}

const LAST_TREATMENT = sql<Date | null>`(SELECT max(t.applied_at) FROM treatments t
  WHERE t.field_id = f.id AND t.deleted_at IS NULL)`;

async function loadFieldViews(q: Q, ids: string[]): Promise<FieldView[]> {
  if (ids.length === 0) return [];
  const rows = await q
    .selectFrom('fields as f')
    .innerJoin('regions as r', 'r.id', 'f.region_id')
    .innerJoin('organizations as o', 'o.id', 'f.organization_id')
    .select([
      'f.id',
      'f.name',
      'f.area_ha',
      'f.geometry',
      'r.code as region_code',
      'r.name as region_name',
      'o.id as org_id',
      'o.name as org_name',
      'o.type as org_type',
      'o.logo_file_id',
      LAST_TREATMENT.as('last_treatment_at'),
      sql<string>`(SELECT count(*) FROM treatments t WHERE t.field_id = f.id AND t.deleted_at IS NULL)`.as(
        'treatments_count',
      ),
    ])
    .where('f.id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const f = byId.get(id);
    if (!f) return [];
    return [
      {
        id: f.id,
        name: f.name,
        areaHa: f.area_ha,
        region: { code: f.region_code, name: f.region_name },
        geometry: f.geometry ?? null,
        lastTreatmentAt: f.last_treatment_at ? iso(f.last_treatment_at) : null,
        treatmentsCount: Number(f.treatments_count),
        organization: {
          id: f.org_id,
          name: f.org_name,
          type: f.org_type,
          logoUrl: f.logo_file_id ? publicFileUrl(f.logo_file_id) : null,
        },
      },
    ];
  });
}

export interface TreatmentView {
  id: string;
  fieldId: string;
  substance: { id: string; name: string; type: string; waitingPeriodDays: number };
  dose: string;
  doseUnit: string;
  appliedAt: string;
  createdAt: string;
  editableUntil: string;
}

function treatmentQuery(q: Q) {
  return q
    .selectFrom('treatments as t')
    .innerJoin('substances as s', 's.id', 't.substance_id')
    .select([
      't.id',
      't.field_id',
      't.dose',
      't.dose_unit',
      't.applied_at',
      't.created_at',
      's.id as substance_id',
      's.name as substance_name',
      's.type as substance_type',
      's.waiting_period_days',
    ]);
}

type TreatmentRow = Awaited<ReturnType<ReturnType<typeof treatmentQuery>['executeTakeFirstOrThrow']>>;

const treatmentView = (t: TreatmentRow): TreatmentView => ({
  id: t.id,
  fieldId: t.field_id,
  substance: {
    id: t.substance_id,
    name: t.substance_name,
    type: t.substance_type,
    waitingPeriodDays: t.waiting_period_days,
  },
  dose: t.dose,
  doseUnit: t.dose_unit,
  appliedAt: iso(t.applied_at),
  createdAt: iso(t.created_at),
  editableUntil: new Date(new Date(t.created_at as unknown as Date).getTime() + DAY_MS).toISOString(),
});

/** Audit view of a treatment row (API names; `appliedAt` ISO UTC). */
const treatmentAudit = (t: {
  field_id: string;
  substance_id: string;
  dose: string;
  dose_unit: string;
  applied_at: unknown;
}) => ({
  fieldId: t.field_id,
  substanceId: t.substance_id,
  dose: t.dose,
  doseUnit: t.dose_unit,
  appliedAt: iso(t.applied_at),
});

export function fieldsService(c: Container) {
  const { db } = c;

  async function fieldView(q: Q, id: string): Promise<FieldView> {
    const [v] = await loadFieldViews(q, [id]);
    if (!v) throw new Error(`field ${id} vanished`);
    return v;
  }

  /** A non-deleted field `p` may see (own farm; every farm for INSPECTOR/ADMIN), else 404. */
  async function visibleField(p: Principal, id: string): Promise<void> {
    let q = db.selectFrom('fields').select('id').where('id', '=', id).where('deleted_at', 'is', null);
    if (!seesAll(p)) q = q.where('organization_id', '=', p.orgId);
    if (!(await q.executeTakeFirst())) throw new AppProblem(404, 'NOT_FOUND');
  }

  /**
   * The own farm's non-deleted field, locked (writes are FARMER-only, own fields only), else 404. Lock strength (P57):
   * `FOR NO KEY UPDATE` for changes that keep the key (updateField, createTreatment — a parallel createBatch on the
   * field, which locks it FOR KEY SHARE, does not wait); `FOR UPDATE` for deleteField only. The soft delete conflicts
   * with every reference lock (createBatch and updateTreatment read the field FOR KEY SHARE, createTreatment FOR NO KEY
   * UPDATE, each with `deleted_at IS NULL`): it waits for running references, and a reference that waited for it
   * re-checks the condition on the deleted row and fails (createBatch 400 fieldId notFound, treatments 404).
   */
  async function ownFieldForUpdate(
    tx: Transaction<DB>,
    p: Principal,
    id: string,
    purpose: 'update' | 'delete',
  ) {
    const q = tx
      .selectFrom('fields as f')
      .innerJoin('regions as r', 'r.id', 'f.region_id')
      .select(['f.id', 'f.name', 'f.area_ha', 'f.geometry', 'r.code as region_code'])
      .where('f.id', '=', id)
      .where('f.organization_id', '=', p.orgId)
      .where('f.deleted_at', 'is', null);
    const f = await (purpose === 'delete' ? q.forUpdate('f') : q.forNoKeyUpdate('f')).executeTakeFirst();
    if (!f) throw new AppProblem(404, 'NOT_FOUND');
    return f;
  }

  async function regionId(q: Q, code: string): Promise<string> {
    // FOR KEY SHARE: a parallel deleteDictionaryEntry of the region waits and then sees this field (P23).
    const r = await q
      .selectFrom('regions')
      .select('id')
      .where('code', '=', code)
      .forKeyShare()
      .executeTakeFirst();
    if (!r) throw validationProblem({ regionCode: ['validation.notFound'] });
    return r.id;
  }

  /** TreatmentInput references and dates (400, collected): non-deleted substance, appliedAt not in the future. */
  async function checkTreatmentRefs(q: Q, input: { substanceId: string; appliedAt: string }, now: Date) {
    const errors: Record<string, string[]> = {};
    const s = await q
      .selectFrom('substances')
      .select('id')
      .where('id', '=', input.substanceId.toLowerCase())
      .where('deleted_at', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (!s) errors.substanceId = ['validation.notFound'];
    if (Date.parse(input.appliedAt) > now.getTime()) errors.appliedAt = ['validation.date.future'];
    if (Object.keys(errors).length > 0) throw validationProblem(errors);
  }

  return {
    /** listFields — own farm for FARMER, all for INSPECTOR/ADMIN (organizationId only for them, R51). */
    async list(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(FIELD_SORT);
      const text = q.q();
      const regionCode = q.matching('regionCode', REGION_CODE);
      let organizationId: string | undefined;
      if (seesAll(p)) organizationId = q.uuid('organizationId');
      else q.notAllowed('organizationId');
      q.done();

      let base = db.selectFrom('fields as f').where('f.deleted_at', 'is', null);
      const orgId = seesAll(p) ? organizationId : p.orgId;
      if (orgId) base = base.where('f.organization_id', '=', orgId);
      if (regionCode !== undefined)
        base = base.where(
          'f.region_id',
          'in',
          db.selectFrom('regions').select('id').where('code', '=', regionCode),
        );
      if (text !== undefined) base = base.where(sql<boolean>`position(lower(${text}) in lower(f.name)) > 0`);
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = {
        name: sql`f.name COLLATE "C"`,
        areaHa: sql`f.area_ha`,
        lastTreatmentAt: LAST_TREATMENT,
        createdAt: sql`f.created_at`,
      }[sort.field as 'name' | 'areaHa' | 'lastTreatmentAt' | 'createdAt'];
      const rows = await base
        .select('f.id')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC NULLS LAST` : sql`${order} DESC NULLS LAST`)
        .orderBy(sql`f.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadFieldViews(
          db,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    /** createField — in the user's farm; unknown regionCode → 400 notFound. */
    async create(p: Principal, body: unknown): Promise<FieldView> {
      const input = parseFieldInput(body);
      const id = await withTx(db, async (tx) => {
        const region = await regionId(tx, input.regionCode);
        const f = await tx
          .insertInto('fields')
          .values({
            organization_id: p.orgId,
            name: input.name,
            area_ha: input.areaHa,
            geometry: input.geometry ? JSON.stringify(input.geometry) : null,
            region_id: region,
            created_by: p.userId,
          })
          .returning(['id', 'area_ha'])
          .executeTakeFirstOrThrow();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createField',
          entityType: 'field',
          entityId: f.id,
          diff: auditDiff(null, {
            name: input.name,
            areaHa: f.area_ha,
            regionCode: input.regionCode,
            geometry: input.geometry ?? null,
            organizationId: p.orgId,
          }),
        });
        return f.id;
      });
      return fieldView(db, id);
    },

    async get(p: Principal, id: string): Promise<FieldView> {
      await visibleField(p, id);
      return fieldView(db, id);
    },

    /** updateField — full replacement (absent geometry → none); last write wins (no version). */
    async update(p: Principal, id: string, body: unknown): Promise<FieldView> {
      const input = parseFieldInput(body);
      await withTx(db, async (tx) => {
        const f = await ownFieldForUpdate(tx, p, id, 'update');
        const region = await regionId(tx, input.regionCode);
        const before = {
          name: f.name,
          areaHa: f.area_ha,
          regionCode: f.region_code,
          geometry: f.geometry ?? null,
        };
        // Nothing changes → no write (updated_at kept), no audit row.
        if (
          canonical(before) ===
          canonical({
            name: input.name,
            areaHa: input.areaHa,
            regionCode: input.regionCode,
            geometry: input.geometry ?? null,
          })
        )
          return;
        const after = await tx
          .updateTable('fields')
          .set({
            name: input.name,
            area_ha: input.areaHa,
            region_id: region,
            geometry: input.geometry ? JSON.stringify(input.geometry) : null,
            updated_at: sql`now()`,
          })
          .where('id', '=', id)
          .returning(['area_ha', 'geometry'])
          .executeTakeFirstOrThrow();
        const diff = auditDiff(before, {
          name: input.name,
          areaHa: after.area_ha,
          regionCode: input.regionCode,
          geometry: after.geometry ?? null,
        });
        if (Object.keys(diff).length > 0)
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'updateField',
            entityType: 'field',
            entityId: id,
            diff,
          });
      });
      return fieldView(db, id);
    },

    /** deleteField — soft; treatments stay (BR-01 of existing batches), new ones are refused (404). */
    async remove(p: Principal, id: string): Promise<void> {
      await withTx(db, async (tx) => {
        await ownFieldForUpdate(tx, p, id, 'delete');
        const now = await txNow(tx);
        await tx.updateTable('fields').set({ deleted_at: now }).where('id', '=', id).execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'deleteField',
          entityType: 'field',
          entityId: id,
          diff: { deletedAt: [null, now.toISOString()] },
        });
      });
    },

    /** listFieldTreatments — the field's non-deleted treatments; substanceId; from/to by UTC date of appliedAt. */
    async listTreatments(p: Principal, fieldId: string, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(TREATMENT_SORT);
      const substanceId = q.uuid('substanceId');
      const { from, to } = q.dateRange();
      q.done();
      await visibleField(p, fieldId);

      let base = db
        .selectFrom('treatments as t')
        .where('t.field_id', '=', fieldId)
        .where('t.deleted_at', 'is', null);
      if (substanceId) base = base.where('t.substance_id', '=', substanceId);
      if (from) base = base.where('t.applied_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('t.applied_at', '<', dayAfter(to));
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const column = sort.field === 'createdAt' ? 't.created_at' : 't.applied_at';
      const ids = await base
        .select('t.id')
        .orderBy(column, sort.dir)
        .orderBy(sql`t.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      const rows = ids.length
        ? await treatmentQuery(db)
            .where(
              't.id',
              'in',
              ids.map((r) => r.id),
            )
            .execute()
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      return {
        items: ids.map((r) => treatmentView(byId.get(r.id)!)),
        page,
        size,
        total: Number(total),
      };
    },

    /** createTreatment — order: body → 404 (own non-deleted field, locked) → references/dates (400). */
    async createTreatment(p: Principal, fieldId: string, body: unknown): Promise<TreatmentView> {
      const input = TreatmentInputSchema.parse(body);
      const id = await withTx(db, async (tx) => {
        await ownFieldForUpdate(tx, p, fieldId, 'update');
        const now = await txNow(tx);
        await checkTreatmentRefs(tx, input, now);
        const t = await tx
          .insertInto('treatments')
          .values({
            field_id: fieldId,
            substance_id: input.substanceId.toLowerCase(),
            dose: input.dose,
            dose_unit: input.doseUnit,
            applied_at: input.appliedAt,
            created_at: now,
            updated_at: now,
            created_by: p.userId,
          })
          .returning(['id', 'field_id', 'substance_id', 'dose', 'dose_unit', 'applied_at'])
          .executeTakeFirstOrThrow();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'createTreatment',
          entityType: 'treatment',
          entityId: t.id,
          diff: auditDiff(null, treatmentAudit(t)),
        });
        return t.id;
      });
      return treatmentView(await treatmentQuery(db).where('t.id', '=', id).executeTakeFirstOrThrow());
    },

    /**
     * updateTreatment — order: body → 404 (missing/deleted treatment, or its field deleted or not the user's farm) →
     * 403 EDIT_WINDOW_CLOSED (now > createdAt + 24 h) → references/dates (400). The window is not extended.
     */
    async updateTreatment(p: Principal, id: string, body: unknown): Promise<TreatmentView> {
      const input = TreatmentInputSchema.parse(body);
      await withTx(db, async (tx) => {
        // Lock order field → treatment (as createTreatment): the field FOR KEY SHARE, so a parallel deleteField
        // (FOR UPDATE) cannot interleave; then the treatment row.
        const owner = await tx
          .selectFrom('treatments')
          .select('field_id')
          .where('id', '=', id)
          .executeTakeFirst();
        const field = owner
          ? await tx
              .selectFrom('fields')
              .select('id')
              .where('id', '=', owner.field_id)
              .where('deleted_at', 'is', null)
              .where('organization_id', '=', p.orgId)
              .forKeyShare()
              .executeTakeFirst()
          : undefined;
        if (!field) throw new AppProblem(404, 'NOT_FOUND');
        const t = await tx
          .selectFrom('treatments as t')
          .innerJoin('fields as f', 'f.id', 't.field_id')
          .select([
            't.id',
            't.field_id',
            't.substance_id',
            't.dose',
            't.dose_unit',
            't.applied_at',
            't.created_at',
          ])
          .where('t.id', '=', id)
          .where('t.deleted_at', 'is', null)
          .where('f.deleted_at', 'is', null)
          .where('f.organization_id', '=', p.orgId)
          .forNoKeyUpdate('t')
          .executeTakeFirst();
        if (!t) throw new AppProblem(404, 'NOT_FOUND');
        const now = await txNow(tx);
        const createdAt = iso(t.created_at);
        if (!canEditTreatment({ createdAt, now: now.toISOString() }).allowed)
          throw new AppProblem(403, 'FORBIDDEN', {
            title: 'Edit window closed',
            params: {
              reason: 'EDIT_WINDOW_CLOSED',
              editableUntil: new Date(Date.parse(createdAt) + DAY_MS).toISOString(),
            },
          });
        await checkTreatmentRefs(tx, input, now);
        const after = await tx
          .updateTable('treatments')
          .set({
            substance_id: input.substanceId.toLowerCase(),
            dose: input.dose,
            dose_unit: input.doseUnit,
            applied_at: input.appliedAt,
            updated_at: now,
          })
          .where('id', '=', id)
          .returning(['field_id', 'substance_id', 'dose', 'dose_unit', 'applied_at'])
          .executeTakeFirstOrThrow();
        const diff = auditDiff(treatmentAudit(t), treatmentAudit(after));
        if (Object.keys(diff).length > 0)
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'updateTreatment',
            entityType: 'treatment',
            entityId: id,
            diff,
          });
      });
      return treatmentView(await treatmentQuery(db).where('t.id', '=', id).executeTakeFirstOrThrow());
    },
  };
}

/** JSON with object keys sorted — jsonb reorders keys, so stored and sent geometry compare by content. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
