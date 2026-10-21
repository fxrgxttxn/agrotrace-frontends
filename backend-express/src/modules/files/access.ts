/**
 * Bearer access to a file (downloadFile, п. 4.2: "files inherit the rights of the entity they belong to"). A file the
 * principal may not read is indistinguishable from a missing one (404). Signed URLs skip this check entirely.
 *
 * - AVATAR — any authenticated user; LOGO, PRODUCT_IMAGE — everybody.
 * - LAB_PROTOCOL — whoever sees the lab test (tag Lab): INSPECTOR and ADMIN all; LAB — tests of the own laboratory;
 *   FARMER/PROCESSOR/RETAILER — tests of the batches they see (tag Batches, S ∪ N).
 * - QR — whoever sees the batch the QR belongs to (tag Batches).
 * - REPORT — only the user it was generated for (owner).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import type { Principal } from '../../security/jwt.js';
import { batchVisibleTo, isParticipant, seesAll } from '../batches/visibility.js';
import type { FileRow } from './service.js';

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
      const own = p.roles.includes('LAB');
      const viaBatch = isParticipant(p)
        ? batchVisibleTo({ ...p, roles: p.roles.filter((r) => r !== 'LAB') }, sql.ref('b.id'))
        : sql<boolean>`false`;
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM lab_tests t JOIN batches b ON b.id = t.batch_id
           WHERE t.protocol_file_id = ${f.id} AND t.deleted_at IS NULL AND b.deleted_at IS NULL
             AND ((${own} AND t.lab_org_id = ${p.orgId}) OR ${viaBatch})
        ) AS ok`.execute(db);
      return r.rows[0]?.ok === true;
    }
    case 'QR': {
      const r = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM batches b
           WHERE (b.qr_png_file_id = ${f.id} OR b.qr_pdf_file_id = ${f.id}) AND b.deleted_at IS NULL
             AND ${batchVisibleTo(p, sql.ref('b.id'))}
        ) AS ok`.execute(db);
      return r.rows[0]?.ok === true;
    }
    default:
      return false;
  }
}
