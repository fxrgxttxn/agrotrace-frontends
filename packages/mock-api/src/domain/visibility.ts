import type { Store } from '../store/store.js';
import type { BatchRow, LabTestRow, Principal, WaybillRow } from '../store/types.js';

const PARTICIPANT = ['FARMER', 'PROCESSOR', 'RETAILER'] as const;

export const seesAll = (p: Principal): boolean => p.roles.includes('INSPECTOR') || p.roles.includes('ADMIN');
const isParticipant = (p: Principal): boolean => p.roles.some((r) => (PARTICIPANT as readonly string[]).includes(r));

export function visibleBatchIds(store: Store, p: Principal): Set<string> {
  const live = store.t.batches.filter((b) => b.deleted_at === null);
  if (seesAll(p)) return new Set(live.map((b) => b.id));
  const out = new Set<string>();
  if (p.roles.includes('LAB'))
    for (const t of store.t.lab_tests) if (t.deleted_at === null && t.lab_org_id === p.orgId) out.add(t.batch_id);
  if (isParticipant(p)) {
    const s = new Set<string>();
    for (const b of live) if (b.origin_org_id === p.orgId || b.holder_org_id === p.orgId) s.add(b.id);
    for (const w of store.t.waybills) {
      if (w.deleted_at !== null || w.status === 'DRAFT') continue;
      if (w.sender_org_id !== p.orgId && w.receiver_org_id !== p.orgId) continue;
      for (const i of store.t.waybill_items) if (i.waybill_id === w.id) s.add(i.batch_id);
    }
    for (const id of s) out.add(id);
    for (const l of store.t.batch_links) {
      if (s.has(l.parent_batch_id)) out.add(l.child_batch_id);
      if (s.has(l.child_batch_id)) out.add(l.parent_batch_id);
    }
  }
  for (const id of [...out]) {
    const b = store.get('batches', id);
    if (!b || b.deleted_at !== null) out.delete(id);
  }
  return out;
}

export function canSeeBatch(store: Store, p: Principal, b: BatchRow | undefined): b is BatchRow {
  return !!b && b.deleted_at === null && visibleBatchIds(store, p).has(b.id);
}

export function canSeeWaybill(p: Principal, w: WaybillRow | undefined): w is WaybillRow {
  if (!w || w.deleted_at !== null) return false;
  if (isParticipant(p) && (w.sender_org_id === p.orgId || (w.receiver_org_id === p.orgId && w.status !== 'DRAFT')))
    return true;
  return seesAll(p) && w.status !== 'DRAFT';
}

export function canSeeLabTest(store: Store, p: Principal, t: LabTestRow | undefined, batches?: Set<string>): t is LabTestRow {
  if (!t || t.deleted_at !== null) return false;
  if (seesAll(p)) return true;
  if (p.roles.includes('LAB') && t.lab_org_id === p.orgId) return true;
  if (isParticipant(p)) return (batches ?? visibleBatchIds(store, p)).has(t.batch_id);
  return false;
}

export function canSeeOrganization(store: Store, p: Principal, orgId: string): boolean {
  const o = store.get('organizations', orgId);
  if (!o || o.deleted_at !== null) return false;
  if (seesAll(p) || o.id === p.orgId) return true;
  return store.t.waybills.some(
    (w) =>
      w.deleted_at === null &&
      ((w.sender_org_id === p.orgId && w.receiver_org_id === o.id) ||
        (w.receiver_org_id === p.orgId && w.sender_org_id === o.id && w.status !== 'DRAFT')),
  );
}
