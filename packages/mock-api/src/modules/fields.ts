import { canEditTreatment } from '@agrotrace/domain';
import { FieldInputSchema, TreatmentInputSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, noContent, type Ctx, type Handler } from '../http/context.js';
import { inDateRange, paginate, uuidParam } from '../http/params.js';
import { ApiError, notFound, validation } from '../http/problem.js';
import { seesAll } from '../domain/visibility.js';
import { contains, sortBy } from '../lib/sort.js';
import { DAY_MS, iso } from '../lib/time.js';
import type { Mock } from '../runtime.js';
import type { FieldRow, TreatmentRow } from '../store/types.js';
import { orgRef, region } from '../views/refs.js';

const RING = 'validation.geometry.ringNotClosed';
const REGION_CODE = /^[0-9A-Z-]{1,8}$/;

function parseField(raw: unknown) {
  try {
    return parseBody(FieldInputSchema, raw);
  } catch (e) {
    if (!(e instanceof ApiError) || !e.extras.errors) throw e;
    const errors = { ...e.extras.errors };
    for (const [path, keys] of Object.entries(errors)) {
      if (path === 'geometry' || !path.startsWith('geometry') || !keys.includes(RING)) continue;
      const rest = keys.filter((k) => k !== RING);
      if (rest.length > 0) errors[path] = rest;
      else delete errors[path];
      const at = (errors.geometry ??= []);
      if (!at.includes(RING)) at.push(RING);
    }
    throw validation(errors);
  }
}

const liveTreatments = (m: Mock, fieldId: string): TreatmentRow[] =>
  m.store.t.treatments.filter((t) => t.field_id === fieldId && t.deleted_at === null);

const lastTreatmentAt = (m: Mock, f: FieldRow): string | null =>
  liveTreatments(m, f.id).reduce<string | null>((max, t) => (max === null || Date.parse(t.applied_at) > Date.parse(max) ? t.applied_at : max), null);

export function fieldView(m: Mock, f: FieldRow) {
  return {
    id: f.id,
    name: f.name,
    areaHa: f.area_ha,
    region: region(m, f.region_id),
    geometry: f.geometry ?? null,
    lastTreatmentAt: lastTreatmentAt(m, f),
    treatmentsCount: liveTreatments(m, f.id).length,
    organization: orgRef(m, f.organization_id),
  };
}

export function treatmentView(m: Mock, t: TreatmentRow) {
  const s = m.store.must('substances', t.substance_id);
  return {
    id: t.id,
    fieldId: t.field_id,
    substance: { id: s.id, name: s.name, type: s.type, waitingPeriodDays: s.waiting_period_days },
    dose: t.dose,
    doseUnit: t.dose_unit,
    appliedAt: t.applied_at,
    createdAt: t.created_at,
    editableUntil: iso(Date.parse(t.created_at) + DAY_MS),
  };
}

function visibleField(ctx: Ctx, id: string): FieldRow {
  const f = ctx.store.get('fields', id);
  if (!f || f.deleted_at !== null || (!seesAll(ctx.user()) && f.organization_id !== ctx.user().orgId)) throw notFound();
  return f;
}

function ownField(ctx: Ctx, id: string): FieldRow {
  const f = ctx.store.get('fields', id);
  if (!f || f.deleted_at !== null || f.organization_id !== ctx.user().orgId) throw notFound();
  return f;
}

function regionId(ctx: Ctx, code: string): string {
  const r = ctx.store.t.regions.find((x) => x.code === code);
  if (!r) throw validation({ regionCode: ['validation.notFound'] });
  return r.id;
}

function treatmentRefs(ctx: Ctx, input: { substanceId: string; appliedAt: string }): void {
  const errors: Record<string, string[]> = {};
  const s = ctx.store.get('substances', input.substanceId.toLowerCase());
  if (!s || s.deleted_at !== null) errors.substanceId = ['validation.notFound'];
  if (Date.parse(input.appliedAt) > ctx.store.now()) errors.appliedAt = ['validation.date.future'];
  if (Object.keys(errors).length > 0) throw validation(errors);
}


export const fieldsHandlers: Record<string, Handler> = {
  listFields(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'], default: 'name,asc' });
    const text = q.q();
    const regionCode = q.matching('regionCode', REGION_CODE);
    let organizationId: string | undefined;
    if (seesAll(p)) organizationId = q.uuid('organizationId');
    else q.notAllowed('organizationId');
    q.done();
    let rows = ctx.store.t.fields.filter((f) => f.deleted_at === null);
    const orgId = seesAll(p) ? organizationId : p.orgId;
    if (orgId) rows = rows.filter((f) => f.organization_id === orgId);
    if (regionCode !== undefined) rows = rows.filter((f) => ctx.store.must('regions', f.region_id).code === regionCode);
    if (text !== undefined) rows = rows.filter((f) => contains(f.name, text));
    const keys = {
      name: [(f: FieldRow) => f.name, 'text'],
      areaHa: [(f: FieldRow) => f.area_ha, 'decimal'],
      lastTreatmentAt: [(f: FieldRow) => lastTreatmentAt(ctx, f), 'time'],
      createdAt: [(f: FieldRow) => f.created_at, 'time'],
    } as const;
    const [key, kind] = keys[sort.field as keyof typeof keys];
    const pg = paginate(sortBy(rows, key, kind, sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((f) => fieldView(ctx, f)) });
  },

  async createField(ctx) {
    const p = ctx.user();
    const input = parseField(await ctx.json());
    const rid = regionId(ctx, input.regionCode);
    const now = ctx.store.nowIso();
    const f = ctx.store.insert('fields', {
      id: ctx.store.id('field'),
      organization_id: p.orgId,
      name: input.name,
      area_ha: input.areaHa,
      geometry: input.geometry ?? null,
      region_id: rid,
      created_at: now,
      updated_at: now,
      created_by: p.userId,
      deleted_at: null,
    });
    ctx.store.created('field', f);
    return json(201, fieldView(ctx, f));
  },

  getField: (ctx) => json(200, fieldView(ctx, visibleField(ctx, uuidParam(ctx.params.id)))),

  async updateField(ctx) {
    const id = uuidParam(ctx.params.id);
    const input = parseField(await ctx.json());
    const f = ownField(ctx, id);
    const rid = regionId(ctx, input.regionCode);
    const next = { name: input.name, area_ha: input.areaHa, region_id: rid, geometry: input.geometry ?? null };
    const same =
      f.name === next.name && f.area_ha === next.area_ha && f.region_id === next.region_id && JSON.stringify(f.geometry ?? null) === JSON.stringify(next.geometry);
    if (!same) {
      ctx.store.touch('field', f);
      ctx.store.patch(f, { ...next, updated_at: ctx.store.nowIso() });
    }
    return json(200, fieldView(ctx, f));
  },

  deleteField(ctx) {
    const f = ownField(ctx, uuidParam(ctx.params.id));
    ctx.store.touch('field', f);
    ctx.store.patch(f, { deleted_at: ctx.store.nowIso() });
    return noContent();
  },

  listFieldTreatments(ctx) {
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['appliedAt', 'createdAt'], default: 'appliedAt,desc' });
    const substanceId = q.uuid('substanceId');
    const range = q.dateRange();
    q.done();
    const f = visibleField(ctx, id);
    let rows = liveTreatments(ctx, f.id);
    if (substanceId) rows = rows.filter((t) => t.substance_id === substanceId);
    if (range.from || range.to) rows = rows.filter((t) => inDateRange(range, t.applied_at));
    const key = sort.field === 'createdAt' ? (t: TreatmentRow) => t.created_at : (t: TreatmentRow) => t.applied_at;
    const pg = paginate(sortBy(rows, key, 'time', sort.dir), page, size);
    return json(200, { ...pg, items: pg.items.map((t) => treatmentView(ctx, t)) });
  },

  async createTreatment(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const input = parseBody(TreatmentInputSchema, await ctx.json());
    const f = ownField(ctx, id);
    treatmentRefs(ctx, input);
    const now = ctx.store.nowIso();
    const t = ctx.store.insert('treatments', {
      id: ctx.store.id('treatment'),
      field_id: f.id,
      substance_id: input.substanceId.toLowerCase(),
      dose: input.dose,
      dose_unit: input.doseUnit,
      applied_at: new Date(input.appliedAt).toISOString(),
      created_at: now,
      updated_at: now,
      created_by: p.userId,
      deleted_at: null,
    });
    ctx.store.created('treatment', t);
    return json(201, treatmentView(ctx, t));
  },

  async updateTreatment(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const input = parseBody(TreatmentInputSchema, await ctx.json());
    const t = ctx.store.get('treatments', id);
    const f = t ? ctx.store.get('fields', t.field_id) : undefined;
    if (!t || t.deleted_at !== null || !f || f.deleted_at !== null || f.organization_id !== p.orgId) throw notFound();
    if (!canEditTreatment({ createdAt: t.created_at, now: ctx.store.nowIso() }).allowed)
      throw new ApiError(403, 'FORBIDDEN', {
        title: 'Edit window closed',
        params: { reason: 'EDIT_WINDOW_CLOSED', editableUntil: iso(Date.parse(t.created_at) + DAY_MS) },
      });
    treatmentRefs(ctx, input);
    const next = {
      substance_id: input.substanceId.toLowerCase(),
      dose: input.dose,
      dose_unit: input.doseUnit,
      applied_at: new Date(input.appliedAt).toISOString(),
    };
    const same = (Object.keys(next) as (keyof typeof next)[]).every((k) =>
      k === 'applied_at' ? Date.parse(t[k]) === Date.parse(next[k]) : t[k] === next[k],
    );
    if (!same) {
      ctx.store.touch('treatment', t);
      ctx.store.patch(t, { ...next, updated_at: ctx.store.nowIso() });
    }
    return json(200, treatmentView(ctx, t));
  },
};
