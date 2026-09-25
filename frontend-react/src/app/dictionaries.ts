import { useQuery } from '@tanstack/react-query';
import type { Schemas } from '@agrotrace/api-client';
import { call } from './api';
import { useSession } from './session';

// Reference dictionaries for selects (products, substances, regions): read by every signed-in role, small, changed
// only by an admin — loaded whole (100 per page, every page), sorted by name, cached for the session.

type Entries = {
  products: Schemas['Product'];
  substances: Schemas['Substance'];
  regions: Schemas['RegionEntry'];
};

const PAGE = 100;

export function useDictionary<N extends keyof Entries>(name: N) {
  const { api } = useSession();
  return useQuery({
    queryKey: ['dictionary', name],
    staleTime: 10 * 60 * 1000,
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
