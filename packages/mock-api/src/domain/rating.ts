import { nextTrustRating } from '@agrotrace/domain';
import tr from '../../../../contracts/rules/trust-rating.json' with { type: 'json' };
import type { Store } from '../store/store.js';

export function foldRating(store: Store, orgId: string): number {
  type E = { at: string; order: number; id: string; event: 'LAB_PASS' | 'LAB_FAIL' | 'RECALL_SOURCE' };
  const events: E[] = [];
  const own = (batchId: string): boolean => {
    const b = store.get('batches', batchId);
    return !!b && b.origin_org_id === orgId && b.deleted_at === null;
  };
  for (const t of store.t.lab_tests)
    if (t.status === 'DONE' && t.deleted_at === null && own(t.batch_id))
      events.push({ at: t.completed_at!, order: 0, id: t.id, event: t.conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL' });
  for (const r of store.t.recalls) {
    const b = store.get('batches', r.source_batch_id);
    if (r.deleted_at === null && b?.origin_org_id === orgId)
      events.push({ at: r.opened_at, order: 1, id: r.id, event: 'RECALL_SOURCE' });
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return events.reduce((current, e) => nextTrustRating({ current, event: e.event }).rating, tr.initial);
}

export function recalculateRating(store: Store, orgId: string): void {
  store.afterCommit(() => {
    const org = store.get('organizations', orgId);
    if (!org || org.type !== 'FARM') return;
    const rating = foldRating(store, orgId);
    if (rating === org.trust_rating) return;
    store.audit({
      action: 'system.ratingRecalculate',
      actorId: null,
      entityType: 'organization',
      entityId: orgId,
      diff: { trustRating: [org.trust_rating, rating] },
    });
    store.patch(org, { trust_rating: rating, updated_at: store.nowIso() });
  });
}
