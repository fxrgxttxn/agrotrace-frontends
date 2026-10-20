/**
 * The ownership path of a batch (R45): getBatchPath (`PathStep`) and the public page (`PublicBatch.path`) share it.
 * The first stage is the originating organization from `harvestedAt` (RAW) or `producedAt` (DERIVED); every ACCEPTED,
 * non-deleted waybill with the batch (by acceptedAt, then waybill number by code points) closes the previous stage and
 * opens the receiver's; the current holder's stage has `to` = null. Sending and rejection create no stage.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import { iso, orgRefs, type OrganizationRef } from './view.js';

type Q = Kysely<DB> | Transaction<DB>;

export interface PathStage {
  org: OrganizationRef;
  from: string;
  to: string | null;
  waybillNumber: string | null;
}

export async function pathStages(
  q: Q,
  b: {
    id: string;
    kind: string;
    origin_org_id: string;
    harvested_at: unknown;
    produced_at: unknown;
    created_at: unknown;
  },
): Promise<PathStage[]> {
  const accepted = await q
    .selectFrom('waybills as w')
    .innerJoin('waybill_items as wi', 'wi.waybill_id', 'w.id')
    .select(['w.number', 'w.receiver_org_id', 'w.accepted_at'])
    .where('wi.batch_id', '=', b.id)
    .where('w.status', '=', 'ACCEPTED')
    .where('w.deleted_at', 'is', null)
    .where('w.accepted_at', 'is not', null)
    .orderBy('w.accepted_at')
    .orderBy(sql`w.number COLLATE "C"`)
    .execute();
  const refs = await orgRefs(q, [b.origin_org_id, ...accepted.map((w) => w.receiver_org_id)]);
  const start = b.kind === 'RAW' ? b.harvested_at : b.produced_at;
  const steps: PathStage[] = [
    { org: refs.get(b.origin_org_id)!, from: iso(start ?? b.created_at), to: null, waybillNumber: null },
  ];
  for (const w of accepted) {
    const at = iso(w.accepted_at);
    steps[steps.length - 1]!.to = at;
    steps.push({ org: refs.get(w.receiver_org_id)!, from: at, to: null, waybillNumber: w.number });
  }
  return steps;
}
