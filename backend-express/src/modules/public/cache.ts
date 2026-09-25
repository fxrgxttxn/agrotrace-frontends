/**
 * The public batch page cache (R82, contract info.description "Shared Redis keys"): `pub:batch:{publicCode}` holds the
 * exact PublicBatch JSON; every operation that changes what a page shows deletes the keys of the affected batches
 * after its commit. The codes are collected inside the transaction (a DB read), the DEL runs after it (P8).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Redis } from 'ioredis';
import type { DB } from '../../db/types.generated.js';

type Q = Kysely<DB> | Transaction<DB>;

/**
 * Batches whose page shows the organization: it originates them, or it is a stage of their `path` (the receiver of
 * an accepted waybill with the batch) — updateAdminOrganization (name, region), uploadOrganizationLogo.
 */
export async function organizationPageCodes(q: Q, orgId: string): Promise<string[]> {
  const r = await sql<{ public_code: string }>`
    SELECT b.public_code FROM batches b WHERE b.origin_org_id = ${orgId}
    UNION
    SELECT b.public_code FROM waybills w
      JOIN waybill_items wi ON wi.waybill_id = w.id
      JOIN batches b ON b.id = wi.batch_id
     WHERE w.receiver_org_id = ${orgId} AND w.status = 'ACCEPTED'`.execute(q);
  return r.rows.map((x) => x.public_code);
}

/** Batches of the products (name or photo shown on the page) — updateDictionaryEntry, importDictionary, photos. */
export async function productPageCodes(q: Q, productIds: readonly string[]): Promise<string[]> {
  if (productIds.length === 0) return [];
  const rows = await q
    .selectFrom('batches')
    .select('public_code')
    .where('product_id', 'in', [...productIds])
    .execute();
  return rows.map((x) => x.public_code);
}

/** Deletes the cached pages (exact keys, in chunks of 500). */
export async function dropPublicPages(redis: Redis, codes: readonly string[]): Promise<void> {
  for (let i = 0; i < codes.length; i += 500)
    await redis.del(...codes.slice(i, i + 500).map((code) => `pub:batch:${code}`));
}
