import type { Me } from '@agrotrace/api-client';
import { canAccess } from '../app/access';
import { CABINET_ROUTES, matchPath } from '../app/routes';

// What the screens need to know about the signed-in person (the cabinet renders pages only with a session). As the
// React screens' useViewer.

export interface Viewer {
  me: Me;
  farmer: boolean;
  /** INSPECTOR or ADMIN: reads every organization's data. */
  overseer: boolean;
  /** Assigns unscheduled lab tests (x-roles of createLabTest). */
  inspector: boolean;
  /** FARMER, PROCESSOR or RETAILER: holder / origin filters. */
  participant: boolean;
  /** The viewer may open `href` (a §9.4 route of their role). */
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
