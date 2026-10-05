import { compareCodePoints } from '@agrotrace/domain';
import { OrganizationAdminPatchSchema } from '@agrotrace/validation';
import { canEntityTransition } from '../domain/transitions.js';
import { parseBody } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { inDateRange, isUuid, paginate, uuidParam } from '../http/params.js';
import { invalidTransition, notFound, validation } from '../http/problem.js';
import { contains, sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { AuditRow, OrganizationRow } from '../store/types.js';
import { logoUrl, orgRef, region } from '../views/refs.js';

const STATUSES = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'] as const;
const TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'] as const;
const ENTITY_TYPES = [
  'organization', 'user', 'field', 'treatment', 'batch', 'waybill', 'labTest', 'recall', 'recallTask', 'complaint',
  'product', 'substance', 'indicator', 'norm', 'region', 'file', 'batchDocument',
] as const;
const BACKENDS = ['express', 'django', 'laravel', 'seed', 'system'] as const;

export function organizationAdminView(m: Mock, o: OrganizationRow) {
  const users = m.store.t.users.filter((u) => u.organization_id === o.id && u.deleted_at === null);
  const head = users
    .filter((u) => u.is_org_admin)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || compareCodePoints(a.id, b.id))[0];
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    logoUrl: logoUrl(m, o.logo_file_id),
    inn: o.inn,
    address: o.address,
    region: region(m, o.region_id),
    trustRating: o.type === 'FARM' ? o.trust_rating : null,
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    usersCount: users.length,
    head: head ? { id: head.id, fullName: head.full_name, email: head.email, phone: head.phone } : null,
  };
}

function liveOrg(m: Mock, id: string): OrganizationRow {
  const o = m.store.get('organizations', id);
  if (!o || o.deleted_at !== null) throw notFound();
  return o;
}

const auditView = (m: Mock, a: AuditRow) => {
  const u = a.actor_id ? m.store.get('users', a.actor_id) : undefined;
  return {
    id: a.id,
    actor: u ? { id: u.id, fullName: u.full_name, organization: orgRef(m, u.organization_id) } : null,
    action: a.action,
    entityType: a.entity_type,
    entityId: a.entity_id,
    diff: a.diff,
    ip: a.ip,
    backend: a.backend,
    requestId: a.request_id,
    createdAt: a.created_at,
  };
};

export const adminHandlers: Record<string, Handler> = {
  listAdminOrganizations(ctx) {
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['createdAt', 'name'], default: 'createdAt,desc' });
    const text = q.q();
    const statuses = q.enumList('status', STATUSES);
    const types = q.enumList('type', TYPES);
    const regionCode = q.matching('regionCode', /^[0-9A-Z-]{1,8}$/);
    q.done();
    let rows = ctx.store.t.organizations.filter((o) => o.deleted_at === null);
    if (statuses) rows = rows.filter((o) => statuses.includes(o.status));
    if (types) rows = rows.filter((o) => types.includes(o.type));
    if (regionCode !== undefined) rows = rows.filter((o) => ctx.store.must('regions', o.region_id).code === regionCode);
    if (text !== undefined) rows = rows.filter((o) => contains(o.name, text) || o.inn.startsWith(text));
    const pg = paginate(
      sort.field === 'name' ? sortBy(rows, (o) => o.name, 'text', sort.dir) : sortBy(rows, (o) => o.created_at, 'time', sort.dir),
      page,
      size,
    );
    return json(200, { ...pg, items: pg.items.map((o) => organizationAdminView(ctx, o)) });
  },

  async updateAdminOrganization(ctx) {
    const id = uuidParam(ctx.params.id);
    const input = parseBody(OrganizationAdminPatchSchema, await ctx.json());
    const o = liveOrg(ctx, id);
    if (input.status !== undefined && input.status !== o.status && (o.type === 'PLATFORM' || !canEntityTransition('organization', o.status, input.status, 'updateAdminOrganization')))
      throw invalidTransition({ from: o.status, to: input.status });
    let regionId = o.region_id;
    if (input.regionCode !== undefined) {
      const r = ctx.store.t.regions.find((x) => x.code === input.regionCode);
      if (!r) throw validation({ regionCode: ['validation.notFound'] });
      regionId = r.id;
    }
    ctx.store.touch('organization', o);
    const changes: Partial<OrganizationRow> = { region_id: regionId };
    if (input.name !== undefined) changes.name = input.name;
    if (input.address !== undefined) changes.address = input.address;
    if (input.status !== undefined) changes.status = input.status;
    if (Object.entries(changes).some(([k, v]) => o[k as keyof OrganizationRow] !== v)) ctx.store.patch(o, { ...changes, updated_at: ctx.store.nowIso() });
    return json(200, organizationAdminView(ctx, o));
  },

  approveOrganization(ctx) {
    const raw = ctx.params.id ?? '';
    if (!isUuid(raw)) throw notFound();
    const o = liveOrg(ctx, raw.toLowerCase());
    if (!canEntityTransition('organization', o.status, 'ACTIVE', 'approveOrganization')) throw invalidTransition({ from: o.status, to: 'ACTIVE' });
    ctx.store.touch('organization', o);
    ctx.store.patch(o, { status: 'ACTIVE', updated_at: ctx.store.nowIso() });
    return json(200, organizationAdminView(ctx, o));
  },

  listAuditLog(ctx) {
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['createdAt'], default: 'createdAt,desc' });
    const actorId = q.uuid('actorId');
    const entityType = q.enumOf('entityType', ENTITY_TYPES);
    const entityId = q.uuid('entityId');
    const action = q.text('action', 64);
    const backend = q.enumOf('backend', BACKENDS);
    const range = q.dateRange();
    q.done();
    let rows = ctx.store.t.audit_log;
    if (actorId) rows = rows.filter((a) => a.actor_id === actorId);
    if (entityType) rows = rows.filter((a) => a.entity_type === entityType);
    if (entityId) rows = rows.filter((a) => a.entity_id === entityId);
    if (action !== undefined) rows = rows.filter((a) => a.action === action);
    if (backend) rows = rows.filter((a) => a.backend === backend);
    if (range.from || range.to) rows = rows.filter((a) => inDateRange(range, a.created_at));
    const sorted = [...rows].sort((x, y) => {
      const c = Date.parse(x.created_at) - Date.parse(y.created_at);
      return (sort.dir === 'asc' ? c : -c) || x.id - y.id;
    });
    const pg = paginate(sorted, page, size);
    return json(200, { ...pg, items: pg.items.map((a) => auditView(ctx, a)) });
  },
};
