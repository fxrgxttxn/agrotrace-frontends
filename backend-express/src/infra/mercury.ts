/**
 * ФГИС «Меркурий» adapter (R81; dev: mercury-mock, `MERCURY_URL`): one list query per call,
 * `GET {MERCURY_URL}/api/v1/vsd?productCode=&senderInn=&dateFrom=&dateTo=`, `MERCURY_TIMEOUT_MS` (10 s) per call.
 * A call either returns the parsed `items` or fails (network error, timeout, non-200 status, a body that is not the
 * Mercury format) — the retry policy belongs to the `vsd.import` handler (contracts/events/vsd.import.schema.json).
 *
 * Test stand only: calls for a product code listed in `MERCURY_FAIL_PRODUCT_CODES` carry `X-Mock-Fail` so
 * mercury-mock fails them on purpose.
 */
import { z } from 'zod';
import { compareCodePoints } from '@agrotrace/domain';

export const VsdSchema = z
  .object({
    uuid: z.string().uuid(),
    number: z.string().min(1).max(64),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(['CONFIRMED', 'WITHDRAWN', 'UTILIZED']),
    product: z.object({ code: z.string(), name: z.string() }),
    volume: z.object({ value: z.number().nonnegative(), unit: z.string() }),
    consignor: z.object({ inn: z.string().regex(/^\d{10}(\d{2})?$/), name: z.string() }),
    consignee: z.object({ inn: z.string().regex(/^\d{10}(\d{2})?$/), name: z.string() }),
  })
  // payload = the whole document (vetInspection and any other field Mercury sends are kept).
  .passthrough();
export type Vsd = z.infer<typeof VsdSchema>;

const ListSchema = z.object({ items: z.array(z.unknown()) });

export interface VsdQuery {
  productCode: string;
  senderInn: string;
  dateFrom: string;
  dateTo: string;
}

export type VsdCall = { ok: true; items: Vsd[] } | { ok: false; error: string };

export interface Mercury {
  listVsd(q: VsdQuery): Promise<VsdCall>;
}

export function createMercury(opts: {
  url: string;
  timeoutMs: number;
  failProductCodes?: readonly string[];
  failMode?: '500' | 'timeout';
  fetchImpl?: typeof fetch;
}): Mercury {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async listVsd(q) {
      const url = new URL(`${opts.url}/api/v1/vsd`);
      url.searchParams.set('productCode', q.productCode);
      url.searchParams.set('senderInn', q.senderInn);
      url.searchParams.set('dateFrom', q.dateFrom);
      url.searchParams.set('dateTo', q.dateTo);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.failProductCodes?.includes(q.productCode)) headers['X-Mock-Fail'] = opts.failMode ?? '500';
      try {
        const res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return { ok: false, error: `mercury: HTTP ${res.status}` };
        }
        const list = ListSchema.safeParse(await res.json());
        if (!list.success) return { ok: false, error: 'mercury: the response is not a VSD list' };
        const items: Vsd[] = [];
        for (const raw of list.data.items) {
          const v = VsdSchema.safeParse(raw);
          if (!v.success)
            return { ok: false, error: 'mercury: a VSD item does not match the Mercury format' };
          items.push(v.data);
        }
        return { ok: true, items };
      } catch (err) {
        const e = err as Error;
        const what = e.name === 'TimeoutError' ? `timeout after ${opts.timeoutMs} ms` : e.message;
        return { ok: false, error: `mercury: ${what}` };
      }
    },
  };
}

/**
 * The document to import (the event schema): among CONFIRMED items the latest — greatest issueDate, then number, then
 * uuid (code-point order); none → null.
 */
export function pickVsd(items: readonly Vsd[]): Vsd | null {
  const cmp = compareCodePoints;
  let best: Vsd | null = null;
  for (const v of items) {
    if (v.status !== 'CONFIRMED') continue;
    if (
      !best ||
      (cmp(v.issueDate, best.issueDate) || cmp(v.number, best.number) || cmp(v.uuid, best.uuid)) > 0
    )
      best = v;
  }
  return best;
}
