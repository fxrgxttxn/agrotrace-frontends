import { availableActions } from '@agrotrace/domain';
import type { Mock } from '../runtime.js';
import type { BatchRow, Principal } from '../store/types.js';
import { batchListItem, orgRef } from './refs.js';

const has = (p: Principal, ...roles: string[]): boolean => p.roles.some((r) => roles.includes(r));

export function batchActions(m: Mock, p: Principal, b: BatchRow): { action: string; to: string }[] {
  const s = m.store;
  const holder = b.holder_org_id === p.orgId;
  const receiverOfSent = (): boolean =>
    s.t.waybills.some(
      (w) =>
        w.status === 'SENT' &&
        w.deleted_at === null &&
        w.receiver_org_id === p.orgId &&
        s.t.waybill_items.some((i) => i.waybill_id === w.id && i.batch_id === b.id),
    );
  return availableActions(b.status).filter(({ action }) => {
    switch (action) {
      case 'ship':
        return has(p, 'FARMER', 'PROCESSOR') && holder;
      case 'accept':
      case 'reject':
        return has(p, 'PROCESSOR', 'RETAILER') && receiverOfSent();
      case 'process':
        return has(p, 'PROCESSOR') && holder;
      case 'putOnSale':
      case 'sell':
        return has(p, 'RETAILER') && holder;
      case 'recall':
        return has(p, 'INSPECTOR');
      case 'writeOff':
        return (
          has(p, 'FARMER', 'PROCESSOR', 'RETAILER') &&
          s.t.recall_tasks.some((t) => t.batch_id === b.id && t.holder_org_id === p.orgId && (t.status === 'OPEN' || t.status === 'OVERDUE'))
        );
      default:
        return false;
    }
  });
}

export function batchView(m: Mock, p: Principal, b: BatchRow) {
  const field = b.field_id ? m.store.get('fields', b.field_id) : undefined;
  return {
    ...batchListItem(m, b),
    field: field ? { id: field.id, name: field.name } : null,
    testRequired: b.test_required,
    testReason: b.test_reason,
    version: b.version,
    actions: batchActions(m, p, b),
  };
}

export function pathSteps(m: Mock, b: BatchRow) {
  const accepted = m.store.t.waybills
    .filter(
      (w) =>
        w.status === 'ACCEPTED' &&
        w.deleted_at === null &&
        w.accepted_at !== null &&
        m.store.t.waybill_items.some((i) => i.waybill_id === w.id && i.batch_id === b.id),
    )
    .sort((x, y) => Date.parse(x.accepted_at!) - Date.parse(y.accepted_at!));
  const steps: { orgId: string; from: string; to: string | null; waybillNumber: string | null }[] = [
    { orgId: b.origin_org_id, from: (b.harvested_at ?? b.produced_at ?? b.created_at)!, to: null, waybillNumber: null },
  ];
  for (const w of accepted) {
    steps[steps.length - 1]!.to = w.accepted_at;
    steps.push({ orgId: w.receiver_org_id, from: w.accepted_at!, to: null, waybillNumber: w.number });
  }
  return steps.map((s) => ({ org: orgRef(m, s.orgId), from: s.from, to: s.to, waybillNumber: s.waybillNumber }));
}

export function qrDenied(m: Mock, p: Principal, b: BatchRow): { reason: string; status?: string } | null {
  if (b.holder_org_id !== p.orgId) return { reason: 'NOT_HOLDER' };
  const allowed =
    b.status === 'Accepted' ||
    b.status === 'OnSale' ||
    (b.status === 'Approved' && b.kind === 'DERIVED' && b.origin_org_id === p.orgId && p.roles.includes('PROCESSOR'));
  return allowed ? null : { reason: 'BATCH_STATUS', status: b.status };
}
