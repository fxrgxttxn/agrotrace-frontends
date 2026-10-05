import type { Me } from '@agrotrace/api-client';
import { canAccess } from '../app/access';
import { CABINET_ROUTES, matchPath } from '../app/routes';

export interface Viewer {
  me: Me;
  farmer: boolean;
  overseer: boolean;
  inspector: boolean;
  participant: boolean;
  may: (href: string) => boolean;
}

export function viewerOf(me: Me): Viewer {
  const has = (r: string) => me.roles.some((x) => x === r);
  return {
    me,
    farmer: has('FARMER'),
    overseer: has('INSPECTOR') || has('ADMIN'),
    inspector: has('INSPECTOR'),
    participant: has('FARMER') || has('PROCESSOR') || has('RETAILER'),
    may: (href) => {
      const path = href.split('?')[0]!;
      const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
      return Boolean(route && canAccess(me, route.access));
    },
  };
}
