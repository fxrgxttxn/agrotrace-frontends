import { useQuery } from '@tanstack/react-query';
import type { Schemas } from '@agrotrace/api-client';
import { call } from './api';
import { useSession } from './session';

type Entries = {
  products: Schemas['Product'];
  substances: Schemas['Substance'];
  regions: Schemas['RegionEntry'];
  indicators: Schemas['Indicator'];
};

const PAGE = 100;

export function useDictionary<N extends keyof Entries>(name: N, enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: ['dictionary', name],
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const items: Entries[N][] = [];
      for (let page = 1; ; page++) {
        const res = await call<Schemas['DictionaryPage']>(
          api.GET('/dictionaries/{name}', {
            params: { path: { name }, query: { page, size: PAGE, sort: 'name,asc' } },
          }),
        );
        items.push(...(res.items as Entries[N][]));
        if (items.length >= res.total || res.items.length === 0) break;
      }
      return items;
    },
  });
}
