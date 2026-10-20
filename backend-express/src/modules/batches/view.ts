/**
 * The contract's batch views: `BatchListItem`, `Batch` (with the caller's `actions`), shared references
 * `OrganizationRef` / `ProductRef` (public logo/photo URLs).
 *
 * `actions` (schema `Batch`): the transitions of contracts/rules/state-machine.json from the current status
 * (`availableActions`, file order) the caller may perform — ship (FARMER/PROCESSOR holder), accept/reject
 * (PROCESSOR/RETAILER receiver of a SENT waybill with the batch), process (PROCESSOR holder), putOnSale/sell (RETAILER
 * holder), recall (INSPECTOR), writeOff (holder of the batch's OPEN/OVERDUE recall task, FARMER/PROCESSOR/RETAILER);
 * never the automatic ones. Business rules are not evaluated here.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { availableActions, type BatchStatus } from '@agrotrace/domain';
import type { DB } from '../../db/types.generated.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import type { Principal } from '../../security/jwt.js';

type Q = Kysely<DB> | Transaction<DB>;

export const iso = (v: unknown): string => new Date(v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

export interface OrganizationRef {
  id: string;
  name: string;
  type: string;
  logoUrl: string | null;
}
export interface ProductRef {
  id: string;
  name: string;
  category: string;
  imageUrl: string | null;
}

export const orgRef = (id: string, name: string, type: string, logo: string | null): OrganizationRef => ({
  id,
  name,
  type,
  logoUrl: logo ? publicFileUrl(logo) : null,
});

/** OrganizationRef of several organizations by id. */
export async function orgRefs(q: Q, ids: readonly string[]): Promise<Map<string, OrganizationRef>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .selectFrom('organizations')
    .select(['id', 'name', 'type', 'logo_file_id'])
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((o) => [o.id, orgRef(o.id, o.name, o.type, o.logo_file_id)]));
}

export interface BatchListItem {
  id: string;
  publicCode: string;
  product: ProductRef;
  massKg: string;
  status: BatchStatus;
  kind: 'RAW' | 'DERIVED';
  holder: OrganizationRef;
  origin: OrganizationRef;
  harvestedAt: string | null;
  producedAt: string | null;
  updatedAt: string;
  qrGeneratedAt: string | null;
}

export interface BatchCard extends BatchListItem {
  field: { id: string; name: string } | null;
  testRequired: boolean;
  testReason: string;
  version: number;
  actions: { action: string; to: BatchStatus }[];
}

function baseQuery(q: Q) {
  return q
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .innerJoin('organizations as h', 'h.id', 'b.holder_org_id')
    .innerJoin('organizations as o', 'o.id', 'b.origin_org_id')
    .leftJoin('fields as f', 'f.id', 'b.field_id')
    .select([
      'b.id',
      'b.public_code',
      'b.mass_kg',
      'b.status',
      'b.kind',
      'b.harvested_at',
      'b.produced_at',
      'b.updated_at',
      'b.qr_generated_at',
      'b.test_required',
      'b.test_reason',
      'b.version',
      'b.holder_org_id',
      'b.origin_org_id',
      'p.id as product_id',
      'p.name as product_name',
      'p.category as product_category',
      'p.image_file_id as product_image',
      'h.name as holder_name',
      'h.type as holder_type',
      'h.logo_file_id as holder_logo',
      'o.name as origin_name',
      'o.type as origin_type',
      'o.logo_file_id as origin_logo',
      'f.id as field_id',
      'f.name as field_name',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['executeTakeFirstOrThrow']>>;

function listItem(r: Row): BatchListItem {
  return {
    id: r.id,
    publicCode: r.public_code,
    product: {
      id: r.product_id,
      name: r.product_name,
      category: r.product_category,
      imageUrl: r.product_image ? publicFileUrl(r.product_image) : null,
    },
    massKg: r.mass_kg,
    status: r.status as BatchStatus,
    kind: r.kind as 'RAW' | 'DERIVED',
    holder: orgRef(r.holder_org_id!, r.holder_name, r.holder_type, r.holder_logo),
    origin: orgRef(r.origin_org_id, r.origin_name, r.origin_type, r.origin_logo),
    harvestedAt: isoOrNull(r.harvested_at),
    producedAt: isoOrNull(r.produced_at),
    updatedAt: iso(r.updated_at),
    qrGeneratedAt: isoOrNull(r.qr_generated_at),
  };
}

/** BatchListItem of `ids`, in the order of `ids` (missing ids skipped). */
export async function loadListItems(q: Q, ids: readonly string[]): Promise<BatchListItem[]> {
  if (ids.length === 0) return [];
  const rows = await baseQuery(q)
    .where('b.id', 'in', [...ids])
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [listItem(r)] : [];
  });
}

const has = (p: Principal, ...roles: string[]) => p.roles.some((r) => roles.includes(r));

/** The `Batch` card of `id` for `p` (the caller checked visibility). */
export async function loadCard(q: Q, p: Principal, id: string): Promise<BatchCard> {
  const r = await baseQuery(q)
    .select([
      sql<boolean>`EXISTS (SELECT 1 FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
        WHERE wi.batch_id = b.id AND w.status = 'SENT' AND w.deleted_at IS NULL
          AND w.receiver_org_id = ${p.orgId})`.as('receiver_of_sent'),
      sql<boolean>`EXISTS (SELECT 1 FROM recall_tasks t WHERE t.batch_id = b.id
        AND t.holder_org_id = ${p.orgId} AND t.status IN ('OPEN', 'OVERDUE'))`.as('task_holder'),
    ])
    .where('b.id', '=', id)
    .executeTakeFirstOrThrow();
  const holder = r.holder_org_id === p.orgId;
  const actions = availableActions(r.status as BatchStatus).filter(({ action }) => {
    switch (action) {
      case 'ship':
        return has(p, 'FARMER', 'PROCESSOR') && holder;
      case 'accept':
      case 'reject':
        return has(p, 'PROCESSOR', 'RETAILER') && r.receiver_of_sent;
      case 'process':
        return has(p, 'PROCESSOR') && holder;
      case 'putOnSale':
      case 'sell':
        return has(p, 'RETAILER') && holder;
      case 'recall':
        return has(p, 'INSPECTOR');
      case 'writeOff':
        return has(p, 'FARMER', 'PROCESSOR', 'RETAILER') && r.task_holder;
      default:
        return false;
    }
  });
  return {
    ...listItem(r),
    field: r.field_id ? { id: r.field_id, name: r.field_name! } : null,
    testRequired: r.test_required,
    testReason: r.test_reason,
    version: r.version,
    actions,
  };
}
