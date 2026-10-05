import { inject } from '@angular/core';
import type { Schemas } from '@agrotrace/api-client';
import { call } from './api';
import { FOREVER, injectQuery, type Query } from './query';
import { SessionService } from './session';

type Entries = {
  products: Schemas['Product'];
  substances: Schemas['Substance'];
  regions: Schemas['RegionEntry'];
  indicators: Schemas['Indicator'];
};

const PAGE = 100;

export function injectDictionary<N extends keyof Entries>(
  name: N,
  enabled: () => boolean = () => true,
): Query<Entries[N][]> {
  const session = inject(SessionService);
  return injectQuery(
    () =>
      enabled()
        ? {
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
          }
        : null,
    { freshMs: FOREVER },
  );
}
