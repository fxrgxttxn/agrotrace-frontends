import type { Schemas } from '@agrotrace/api-client';
import { call } from './api.svelte';
import { FOREVER, query, type Query } from './cache.svelte';
import { session } from './session.svelte';

type Entries = {
  products: Schemas['Product'];
  substances: Schemas['Substance'];
  regions: Schemas['RegionEntry'];
  indicators: Schemas['Indicator'];
};

const PAGE = 100;

export function dictionary<N extends keyof Entries>(
  name: N,
  enabled: () => boolean = () => true,
): Query<Entries[N][]> {
  return query(
    () => (enabled() ? ['dictionary', name] : null),
    async () => {
      const items: Entries[N][] = [];
      for (let page = 1; ; page++) {
        const res = await call<Schemas['DictionaryPage']>(
          session.api.GET('/dictionaries/{name}', {
            params: { path: { name }, query: { page, size: PAGE, sort: 'name,asc' } },
          }),
        );
        items.push(...(res.items as Entries[N][]));
        if (items.length >= res.total || res.items.length === 0) break;
      }
      return items;
    },
    { freshMs: FOREVER },
  );
}
