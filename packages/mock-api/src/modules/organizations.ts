import { fileRef, insertBytesFile, softDeleteFile } from '../domain/files.js';
import { RASTER_TYPES, readUpload } from '../domain/uploads.js';
import { canSeeOrganization } from '../domain/visibility.js';
import { json, type Handler } from '../http/context.js';
import { paginate, uuidParam } from '../http/params.js';
import { forbidden, notFound } from '../http/problem.js';
import { sortBy } from '../lib/sort.js';
import type { Mock } from '../runtime.js';
import type { OrganizationRow } from '../store/types.js';
import { logoUrl, region } from '../views/refs.js';
import { imageResponse } from './files.js';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const ORG_TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'] as const;

export function organizationView(m: Mock, o: OrganizationRow) {
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
  };
}

export const organizationsHandlers: Record<string, Handler> = {
  listOrganizations(ctx) {
    const q = ctx.query();
    const { page, size, sort } = q.page({ fields: ['name'], default: 'name,asc' });
    const text = q.q();
    const types = q.enumList('type', ORG_TYPES);
    q.done();
    let rows = ctx.store.t.organizations.filter((o) => o.status === 'ACTIVE' && o.type !== 'PLATFORM' && o.deleted_at === null);
    if (types) rows = rows.filter((o) => types.includes(o.type));
    if (text !== undefined)
      rows = rows.filter((o) => o.name.toLowerCase().startsWith(text.toLowerCase()) || o.inn.startsWith(text));
    const pg = paginate(sortBy(rows, (o) => o.name, 'text', sort.dir), page, size);
    return json(200, {
      ...pg,
      items: pg.items.map((o) => ({ id: o.id, name: o.name, type: o.type, logoUrl: logoUrl(ctx, o.logo_file_id), region: region(ctx, o.region_id) })),
    });
  },

  getOrganization(ctx) {
    const id = uuidParam(ctx.params.id);
    if (!canSeeOrganization(ctx.store, ctx.user(), id)) throw notFound();
    return json(200, organizationView(ctx, ctx.store.must('organizations', id)));
  },

  async uploadOrganizationLogo(ctx) {
    const p = ctx.user();
    const id = uuidParam(ctx.params.id);
    const up = await readUpload(ctx, LOGO_MAX_BYTES, [...RASTER_TYPES, 'image/svg+xml'], () => {
      if (!canSeeOrganization(ctx.store, p, id)) throw notFound();
      if (!p.roles.includes('ADMIN') && id !== p.orgId) throw forbidden();
    });
    const variants = up.variants;
    const o = ctx.store.must('organizations', id);
    const file = insertBytesFile(ctx.store, {
      kind: 'LOGO',
      originalName: up.name,
      mime: up.mime,
      data: up.bytes,
      ownerId: p.userId,
      ...(variants && { variants }),
    });
    const old = o.logo_file_id;
    ctx.store.touch('organization', o);
    ctx.store.patch(o, { logo_file_id: file.id, updated_at: ctx.store.nowIso() });
    softDeleteFile(ctx.store, old);
    return json(200, fileRef(ctx.cfg, file));
  },

  getOrganizationLogo(ctx) {
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    const variant = q.enumOf('variant', ['96', '480'] as const);
    q.done();
    if (!canSeeOrganization(ctx.store, ctx.user(), id)) throw notFound();
    return imageResponse(ctx, ctx.store.must('organizations', id).logo_file_id, variant === '96' ? 96 : 480, 'private');
  },
};
