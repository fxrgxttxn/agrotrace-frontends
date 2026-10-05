import type { Schemas } from '@agrotrace/api-client';
import { call } from '../../app/api.svelte';
import { query } from '../../app/cache.svelte';
import { listGap, listParams, type ListSpec } from '../../app/listState.svelte';
import { session } from '../../app/session.svelte';

export type BatchItem = Schemas['BatchListItem'];
export type Batch = Schemas['Batch'];
export type BatchStatus = Schemas['BatchStatus'];
export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';
export const SEVERAL = '__several';

export function stockStatuses(processor: boolean, retailer: boolean): BatchStatus[] {
  const out: BatchStatus[] = [];
  if (processor) for (const s of ['Approved', 'Accepted'] as const) if (!out.includes(s)) out.push(s);
  if (retailer) for (const s of ['Accepted', 'OnSale'] as const) if (!out.includes(s)) out.push(s);
  return out;
}

export function qrStatuses(processor: boolean): BatchStatus[] {
  return (processor ? ['Accepted', 'OnSale', 'Approved'] : ['Accepted', 'OnSale']) as BatchStatus[];
}

export const STOCK_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  uuids: ['productId'],
  texts: ['q'],
};
export const QR_SPEC: ListSpec = {
  sort: ['publicCode', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  texts: ['q'],
};

export function ownBatches(path: string, statuses: BatchStatus[], spec: ListSpec, failed: string) {
  const list = listParams(() => path, spec);
  const q = () => list.get('q');
  const chosen = () => list.params.getAll('status').filter((s) => statuses.includes(s as BatchStatus));
  const productId = () => list.get('productId');
  const batches = query(
    () => ['batches', path, list.page, list.params.get('sort'), q(), chosen().join(','), productId()],
    ([, , pageNo, sort, text, statusesCsv, product]) => {
      const picked = String(statusesCsv) ? String(statusesCsv).split(',') : [];
      return call<Schemas['BatchPage']>(
        session.api.GET('/batches', {
          params: {
            query: {
              holder: 'me',
              status: (picked.length ? picked : statuses) as BatchStatus[],
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(product ? { productId: String(product) } : {}),
            },
          },
        }),
      );
    },
    { failed },
  );
  $effect(() => {
    const data = batches.data;
    if (data && data.items.length === 0 && data.total > 0) list.clampPage(data.total, SIZE);
  });
  return {
    list,
    batches,
    get q() {
      return q();
    },
    get chosen() {
      return chosen();
    },
    get productId() {
      return productId();
    },
    get gap() {
      return batches.data ? listGap(batches.data, list.page, SIZE) : null;
    },
    get count() {
      return (chosen().length ? 1 : 0) + (productId() ? 1 : 0);
    },
  };
}
