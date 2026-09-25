/**
 * DaData "findById/party" (spec FR-IAM-01, 8.9): the organization behind an INN — name and address. Never blocks
 * registration: no API key, a timeout (DADATA_TIMEOUT_MS per attempt), a network error or a 5xx after 3 attempts →
 * `unavailable`, and the organization is saved as MANUAL_CHECK (contract registerOrganization).
 */
import type { Logger } from '../logger.js';

export type PartyLookup =
  | { status: 'found'; name: string; address: string | null }
  | { status: 'notFound' }
  | { status: 'unavailable' };

export interface DaData {
  findParty(inn: string): Promise<PartyLookup>;
}

interface Suggestion {
  value?: string;
  data?: { name?: { short_with_opf?: string; full_with_opf?: string }; address?: { value?: string } };
}

export function createDaData(
  opts: { apiKey: string | undefined; url: string; timeoutMs: number },
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
  backoffMs = 200,
): DaData {
  return {
    async findParty(inn) {
      if (!opts.apiKey) return { status: 'unavailable' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetchImpl(opts.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              authorization: `Token ${opts.apiKey}`,
            },
            body: JSON.stringify({ query: inn, count: 1 }),
            signal: AbortSignal.timeout(opts.timeoutMs),
          });
          // 4xx (bad key, quota) will not heal on retry.
          if (res.status >= 400 && res.status < 500) {
            logger.warn({ status: res.status }, 'dadata rejected the request');
            return { status: 'unavailable' };
          }
          if (!res.ok) throw new Error(`dadata status ${res.status}`);
          const body = (await res.json()) as { suggestions?: Suggestion[] };
          const s = body.suggestions?.[0];
          if (!s) return { status: 'notFound' };
          const name = s.data?.name?.short_with_opf || s.value || s.data?.name?.full_with_opf;
          if (!name) return { status: 'notFound' };
          return {
            status: 'found',
            name: name.slice(0, 255),
            address: s.data?.address?.value?.slice(0, 500) ?? null,
          };
        } catch (err) {
          logger.warn({ err: (err as Error).message, attempt }, 'dadata unavailable');
          if (attempt < 3) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        }
      }
      return { status: 'unavailable' };
    },
  };
}
