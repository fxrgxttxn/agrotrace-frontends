/**
 * Organizations (contracts/openapi/paths/organizations.yaml).
 *
 * Visibility of a card (п. 4.2, getOrganization description): a participant sees the own organization and its direct
 * suppliers and receivers — the counterparties of waybills it can see (as sender: any status; as receiver: not
 * DRAFT; the Waybills tag); INSPECTOR and ADMIN see every organization. Deleted organizations are invisible to all.
 * An invisible organization is indistinguishable from a missing one (404).
 *
 * The directory (listOrganizations, R46) is not limited by visibility: every ACTIVE organization except PLATFORM.
 */
import { sql, type Kysely } from 'kysely';
import type { Request } from 'express';
import type { Container } from '../../container.js';
import type { DB } from '../../db/types.generated.js';
import { withTx } from '../../db/tx.js';
import type { UploadedFile } from '../../http/multipart.js';
import { QueryReader } from '../../http/params.js';
import { AppProblem } from '../../http/problem.js';
import { RASTER_TYPES, type SniffedType } from '../../infra/images.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import {
  fileAuditView,
  fileRef,
  insertFile,
  prepareUpload,
  softDeleteFile,
  storeObjects,
  type FileRef,
} from '../files/service.js';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES: readonly SniffedType[] = [...RASTER_TYPES, 'image/svg+xml'];
const ORG_TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'] as const;
const DIRECTORY_SORT = { fields: ['name'], default: 'name,asc' } as const;

const seesAll = (p: Principal) => p.roles.includes('INSPECTOR') || p.roles.includes('ADMIN');

/** Whether organization `orgId` exists (not deleted) and `p` may see it. */
export async function canSeeOrganization(db: Kysely<DB>, p: Principal, orgId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM organizations o
       WHERE o.id = ${orgId} AND o.deleted_at IS NULL
         AND (${seesAll(p)} OR o.id = ${p.orgId}
              OR EXISTS (SELECT 1 FROM waybills w
                          WHERE w.deleted_at IS NULL
                            AND ((w.sender_org_id = ${p.orgId} AND w.receiver_org_id = o.id)
                              OR (w.receiver_org_id = ${p.orgId} AND w.sender_org_id = o.id
                                  AND w.status <> 'DRAFT'))))
    ) AS ok`.execute(db);
  return r.rows[0]?.ok === true;
}

export interface OrganizationView {
  id: string;
  name: string;
  type: string;
  logoUrl: string | null;
  inn: string;
  address: string | null;
  region: { code: string; name: string };
  trustRating: number | null;
  status: string;
}

export function organizationsService(c: Container) {
  const { db } = c;

  async function visibleOr404(p: Principal, id: string): Promise<void> {
    if (!(await canSeeOrganization(db, p, id))) throw new AppProblem(404, 'NOT_FOUND');
  }

  return {
    async get(p: Principal, id: string): Promise<OrganizationView> {
      await visibleOr404(p, id);
      const o = await db
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
          'r.code as region_code',
          'r.name as region_name',
        ])
        .where('o.id', '=', id)
        .executeTakeFirstOrThrow();
      return {
        id: o.id,
        name: o.name,
        type: o.type,
        logoUrl: o.logo_file_id ? publicFileUrl(o.logo_file_id) : null,
        inn: o.inn,
        address: o.address,
        region: { code: o.region_code, name: o.region_name },
        trustRating: o.type === 'FARM' ? o.trust_rating : null,
        status: o.status,
      };
    },

    /** listOrganizations — ACTIVE, not PLATFORM; `type` (repeated), `q` = name or INN prefix, case-insensitive. */
    async directory(query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(DIRECTORY_SORT);
      const text = q.q();
      const types = q.enumList('type', ORG_TYPES);
      q.done();

      let base = db
        .selectFrom('organizations as o')
        .innerJoin('regions as r', 'r.id', 'o.region_id')
        .where('o.status', '=', 'ACTIVE')
        .where('o.type', '<>', 'PLATFORM')
        .where('o.deleted_at', 'is', null);
      if (types) base = base.where('o.type', 'in', types);
      if (text !== undefined)
        base = base.where(
          sql<boolean>`(starts_with(lower(o.name), lower(${text})) OR starts_with(o.inn, ${text}))`,
        );
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const rows = await base
        .select([
          'o.id',
          'o.name',
          'o.type',
          'o.logo_file_id',
          'r.code as region_code',
          'r.name as region_name',
        ])
        .orderBy(sort.dir === 'asc' ? sql`o.name COLLATE "C" ASC` : sql`o.name COLLATE "C" DESC`)
        .orderBy(sql`o.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: rows.map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          logoUrl: o.logo_file_id ? publicFileUrl(o.logo_file_id) : null,
          region: { code: o.region_code, name: o.region_name },
        })),
        page,
        size,
        total: Number(total),
      };
    },

    /**
     * uploadOrganizationLogo — 404 for an invisible organization, 403 for a visible foreign one (heads: own only;
     * ADMIN: any), then the file (415); the old logo is soft-deleted and the public batch pages that show the
     * organization (origin or a stage of `path`) are dropped from the cache after the commit (R82 `pub:batch:*`).
     */
    async uploadLogo(p: Principal, orgId: string, upload: UploadedFile): Promise<FileRef> {
      await visibleOr404(p, orgId);
      if (!p.roles.includes('ADMIN') && orgId !== p.orgId) throw new AppProblem(403, 'FORBIDDEN');
      const file = await prepareUpload(upload, {
        kind: 'LOGO',
        ownerId: p.userId,
        bucket: c.s3.bucket,
        allowed: LOGO_TYPES,
      });
      await storeObjects(c.s3, file);
      const codes = await withTx(db, async (tx) => {
        const o = await tx
          .selectFrom('organizations')
          .select('logo_file_id')
          .where('id', '=', orgId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!o) throw new AppProblem(404, 'NOT_FOUND');
        const now = new Date();
        await insertFile(tx, file);
        await tx
          .updateTable('organizations')
          .set({ logo_file_id: file.row.id, updated_at: now })
          .where('id', '=', orgId)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadOrganizationLogo',
          entityType: 'file',
          entityId: file.row.id,
          diff: auditDiff(null, fileAuditView(file.row)),
        });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadOrganizationLogo',
          entityType: 'organization',
          entityId: orgId,
          diff: { logoFileId: [o.logo_file_id, file.row.id] },
        });
        if (await softDeleteFile(tx, o.logo_file_id, now))
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'uploadOrganizationLogo',
            entityType: 'file',
            entityId: o.logo_file_id,
            diff: { deletedAt: [null, now.toISOString()] },
          });
        const pages = await sql<{ public_code: string }>`
          SELECT b.public_code FROM batches b WHERE b.origin_org_id = ${orgId}
          UNION
          SELECT b.public_code FROM waybills w
            JOIN waybill_items wi ON wi.waybill_id = w.id
            JOIN batches b ON b.id = wi.batch_id
           WHERE w.receiver_org_id = ${orgId} AND w.status = 'ACCEPTED'`.execute(tx);
        return pages.rows.map((r) => r.public_code);
      });
      for (let i = 0; i < codes.length; i += 500)
        await c.redis.del(...codes.slice(i, i + 500).map((code) => `pub:batch:${code}`));
      return fileRef(c.fileUrls, {
        id: file.row.id,
        kind: 'LOGO',
        mime: file.row.mime,
        size_bytes: String(file.row.size_bytes),
        original_name: file.row.original_name,
      });
    },

    /** The current logo of a visible organization (404: invisible, missing, no logo). */
    async logoFile(p: Principal, orgId: string) {
      await visibleOr404(p, orgId);
      const f = await db
        .selectFrom('organizations as o')
        .innerJoin('files as f', 'f.id', 'o.logo_file_id')
        .selectAll('f')
        .where('o.id', '=', orgId)
        .where('f.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!f) throw new AppProblem(404, 'NOT_FOUND');
      return f;
    },
  };
}
