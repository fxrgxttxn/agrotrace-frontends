import { inject } from '@angular/core';
import type { Schemas } from '@agrotrace/api-client';
import { call } from './api';
import { FOREVER, injectQuery, type Query } from './query';
import { SessionService } from './session';

// Reference dictionaries for selects (products, substances, regions): read by every signed-in role, small, changed
// only by an admin — loaded whole (100 per page, every page), sorted by name, kept until the page is reloaded (ruling
// FM21); the cache belongs to the session. The React app's dictionaries.ts.

type Entries = {
  products: Schemas['Product'];
  substances: Schemas['Substance'];
  regions: Schemas['RegionEntry'];
};

const PAGE = 100;

/** The whole dictionary `name` (create it in an injection context). */
export function injectDictionary<N extends keyof Entries>(name: N): Query<Entries[N][]> {
  const session = inject(SessionService);
  return injectQuery(
    () => ({
      key: `dictionary:${name}`,
      load: async () => {
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
    }),
    { freshMs: FOREVER },
  );
}
