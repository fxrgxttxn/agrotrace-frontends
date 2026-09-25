/**
 * Administration of organizations (contracts/openapi/paths/admin.yaml, FR-ADM-01, FR-IAM-01; R54/D25–D26, R59).
 *
 * Status changes follow contracts/rules/entity-state-machines.json (`organization`): approveOrganization moves
 * PENDING/MANUAL_CHECK → ACTIVE; updateAdminOrganization rejects applications and suspends/resumes (PLATFORM never
 * changes its status). Both lock the organization row first (R47/R59: `organization` in the lock order) and run
 * every check on the locked row. SUSPENDED/REJECTED take effect at sign-in and refresh (auth checks the status);
 * issued access tokens live out their 15 minutes.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import { OrganizationAdminPatchSchema } from '@agrotrace/validation';
import states from '../../../../contracts/rules/entity-state-machines.json' with { type: 'json' };
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { withTx } from '../../db/tx.js';
import { QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { dropPublicPages, organizationPageCodes } from '../public/cache.js';

const STATUSES = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'] as const;
const TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'] as const;
const LIST_SORT = { fields: ['createdAt', 'name'], default: 'createdAt,desc' } as const;
/** Contract `RegionCode`. */
export const REGION_CODE = /^[0-9A-Z-]{1,8}$/;

/** `from>to` pairs the machine allows for the operation `by`. */
const transitionsBy = (by: string) =>
  new Set(states.organization.transitions.filter((t) => t.by === by).map((t) => `${t.from}>${t.to}`));
const BY_UPDATE = transitionsBy('updateAdminOrganization');
const BY_APPROVE = transitionsBy('approveOrganization');

type Q = Kysely<DB> | Transaction<DB>;

export interface OrganizationAdminView {
  id: string;
  name: string;
  type: string;
  logoUrl: string | null;
  inn: string;
  address: string | null;
  region: { code: string; name: string };
  trustRating: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  usersCount: number;
  head: { id: string; fullName: string; email: string; phone: string | null } | null;
}

/** `OrganizationAdmin` views of `ids`, in the order given. */
async function loadViews(q: Q, ids: string[]): Promise<OrganizationAdminView[]> {
  if (ids.length === 0) return [];
  const rows = await q
    .selectFrom('organizations as o')
    .innerJoin('regions as r', 'r.id', 'o.region_id')
    .select([
      'o.id',
      'o.name',
      'o.type',
      'o.logo_file_id',
      'o.inn',
      'o.address',
      'o.trust_rating',
      'o.status',
      'o.created_at',
      'o.updated_at',
      'r.code as region_code',
      'r.name as region_name',
      sql<string>`(SELECT count(*) FROM users u WHERE u.organization_id = o.id AND u.deleted_at IS NULL)`.as(
        'users_count',
      ),
      // The head created at registration: the earliest non-deleted head of the organization (ties by id).
      sql<{ id: string; full_name: string; email: string; phone: string | null } | null>`(
        SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'phone', u.phone)
          FROM users u
         WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.is_org_admin
         ORDER BY u.created_at, u.id LIMIT 1)`.as('head'),
    ])
    .where('o.id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const o = byId.get(id);
    if (!o) return [];
    return [
      {
        id: o.id,
        name: o.name,
        type: o.type,
        logoUrl: o.logo_file_id ? publicFileUrl(o.logo_file_id) : null,
        inn: o.inn,
        address: o.address,
        region: { code: o.region_code, name: o.region_name },
        trustRating: o.type === 'FARM' ? o.trust_rating : null,
        status: o.status,
        createdAt: new Date(o.created_at as unknown as Date).toISOString(),
        updatedAt: new Date(o.updated_at as unknown as Date).toISOString(),
        usersCount: Number(o.users_count),
        head: o.head
          ? {
              id: o.head.id,
              fullName: o.head.full_name,
              email: o.head.email.toLowerCase(),
              phone: o.head.phone,
            }
          : null,
      },
    ];
  });
}

/** The organization row, locked (R47/R59); 404 when missing or deleted. */
async function lockOrganization(tx: Transaction<DB>, id: string) {
  const o = await tx
    .selectFrom('organizations')
    .select(['id', 'type', 'name', 'address', 'region_id', 'status'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!o) throw new AppProblem(404, 'NOT_FOUND');
  return o;
}

export function adminService(c: Container) {
  const { db } = c;

  async function view(id: string): Promise<OrganizationAdminView> {
    const [v] = await loadViews(db, [id]);
    if (!v) throw new Error(`organization ${id} vanished`);
    return v;
  }

  return {
    /** listAdminOrganizations — every non-deleted organization; status/type repeat; regionCode; q (name or INN). */
    async list(query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
      const statuses = q.enumList('status', STATUSES);
      const types = q.enumList('type', TYPES);
      const regionCode = q.matching('regionCode', REGION_CODE);
      q.done();

      let base = db.selectFrom('organizations as o').where('o.deleted_at', 'is', null);
      if (statuses) base = base.where('o.status', 'in', statuses);
      if (types) base = base.where('o.type', 'in', types);
      if (regionCode !== undefined)
        base = base.where(
          'o.region_id',
          'in',
          db.selectFrom('regions').select('id').where('code', '=', regionCode),
        );
      if (text !== undefined)
        // Name: substring without case; INN: prefix. `%`, `_`, `\` are ordinary characters (no LIKE).
        base = base.where(
          sql<boolean>`(position(lower(${text}) in lower(o.name)) > 0 OR starts_with(o.inn, ${text}))`,
        );
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = sort.field === 'name' ? sql`o.name COLLATE "C"` : sql`o.created_at`;
      const rows = await base
        .select('o.id')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC` : sql`${order} DESC`)
        .orderBy(sql`o.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadViews(
          db,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    /**
     * updateAdminOrganization — order: 400 body → lock → 404 → 409 INVALID_TRANSITION (status differs and the machine
     * does not allow it, or PLATFORM) → 400 regionCode notFound. Only changed fields are written and audited; a
     * change of name or region drops the public pages that show the organization (R82).
     */
    async update(p: Principal, id: string, body: unknown): Promise<OrganizationAdminView> {
      const input = OrganizationAdminPatchSchema.parse(body);
      const codes = await withTx(db, async (tx) => {
        const o = await lockOrganization(tx, id);
        if (input.status !== undefined && input.status !== o.status) {
          if (o.type === 'PLATFORM' || !BY_UPDATE.has(`${o.status}>${input.status}`))
            throw new AppProblem(409, 'INVALID_TRANSITION', { params: { from: o.status, to: input.status } });
        }
        const current = await tx
          .selectFrom('regions')
          .select(['id', 'code'])
          .where('id', '=', o.region_id)
          .executeTakeFirstOrThrow();
        let region = current;
        if (input.regionCode !== undefined && input.regionCode !== current.code) {
          const found = await tx
            .selectFrom('regions')
            .select(['id', 'code'])
            .where('code', '=', input.regionCode)
            .forKeyShare()
            .executeTakeFirst();
          if (!found) throw validationProblem({ regionCode: ['validation.notFound'] });
          region = found;
        }
        const before = { name: o.name, address: o.address, regionCode: current.code, status: o.status };
        const after = {
          name: input.name ?? o.name,
          address: input.address !== undefined ? input.address : o.address,
          regionCode: region.code,
          status: input.status ?? o.status,
        };
        const diff = auditDiff(before, after);
        if (Object.keys(diff).length === 0) return [];
        await tx
          .updateTable('organizations')
          .set({
            name: after.name,
            address: after.address,
            region_id: region.id,
            status: after.status,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'updateAdminOrganization',
          entityType: 'organization',
          entityId: id,
          diff,
        });
        return diff.name || diff.regionCode ? organizationPageCodes(tx, id) : [];
      });
      await dropPublicPages(c.redis, codes);
      return view(id);
    },

    /** approveOrganization — PENDING/MANUAL_CHECK → ACTIVE on the locked row; otherwise 409 {from, to: ACTIVE}. */
    async approve(p: Principal, id: string): Promise<OrganizationAdminView> {
      await withTx(db, async (tx) => {
        const o = await lockOrganization(tx, id);
        if (!BY_APPROVE.has(`${o.status}>ACTIVE`))
          throw new AppProblem(409, 'INVALID_TRANSITION', { params: { from: o.status, to: 'ACTIVE' } });
        await tx
          .updateTable('organizations')
          .set({ status: 'ACTIVE', updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'approveOrganization',
          entityType: 'organization',
          entityId: id,
          diff: { status: [o.status, 'ACTIVE'] },
        });
      });
      return view(id);
    },
  };
}
