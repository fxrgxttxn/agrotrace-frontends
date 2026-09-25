/**
 * Bearer access to a file (downloadFile, п. 4.2: "files inherit the rights of the entity they belong to"). A file the
 * principal may not read is indistinguishable from a missing one (404). Signed URLs skip this check entirely.
 *
 * - AVATAR — any authenticated user; LOGO, PRODUCT_IMAGE — everybody.
 * - LAB_PROTOCOL — whoever sees the lab test: INSPECTOR and ADMIN all; LAB — tests of the own laboratory;
 *   FARMER/PROCESSOR/RETAILER — for now only tests of batches the organization created or holds.
 *   TODO(Task 6/9): the full batch visibility (S ∪ N of the Batches tag) once the batches module exists.
 * - QR — the batch's QR: INSPECTOR and ADMIN; otherwise the batch's origin or holder organization.
 *   TODO(Task 6/8): the full batch visibility as above.
 * - REPORT — only the user it was generated for (owner).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import type { Principal } from '../../security/jwt.js';
import type { FileRow } from './service.js';

const seesAll = (p: Principal) => p.roles.includes('INSPECTOR') || p.roles.includes('ADMIN');

export async function canReadFile(db: Kysely<DB>, p: Principal, f: FileRow): Promise<boolean> {
  switch (f.kind) {
    case 'AVATAR':
    case 'LOGO':
    case 'PRODUCT_IMAGE':
      return true;
    case 'REPORT':
      return f.owner_id === p.userId;
    case 'LAB_PROTOCOL': {
      if (seesAll(p)) return true;
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM lab_tests t JOIN batches b ON b.id = t.batch_id
           WHERE t.protocol_file_id = ${f.id} AND t.deleted_at IS NULL AND b.deleted_at IS NULL
             AND ((${p.roles.includes('LAB')} AND t.lab_org_id = ${p.orgId})
               OR (b.origin_org_id = ${p.orgId} OR b.holder_org_id = ${p.orgId}))
        ) AS ok`.execute(db);
      return r.rows[0]?.ok === true;
    }
    case 'QR': {
      if (seesAll(p)) return true;
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM batches b
           WHERE (b.qr_png_file_id = ${f.id} OR b.qr_pdf_file_id = ${f.id}) AND b.deleted_at IS NULL
             AND (b.origin_org_id = ${p.orgId} OR b.holder_org_id = ${p.orgId})
        ) AS ok`.execute(db);
      return r.rows[0]?.ok === true;
    }
    default:
      return false;
  }
}
