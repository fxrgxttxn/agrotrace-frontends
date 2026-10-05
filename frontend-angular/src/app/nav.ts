import { canAccess, type Role, type Viewer } from './access';
import { CABINET_ROUTES, matchPath } from './routes';

export interface NavItem {
  key: string;
  label: string;
  short?: string;
  href: string;
  icon: string;
  section: string;
}

const ITEMS = {
  dashboard: { key: 'dashboard', label: 'nav.dashboard', href: '/', icon: 'graph', section: '/' },
  fields: { key: 'fields', label: 'nav.fields', href: '/fields', icon: 'field', section: '/fields' },
  batches: { key: 'batches', label: 'nav.batches', href: '/batches', icon: 'batch', section: '/batches' },
  waybills: {
    key: 'waybills',
    label: 'nav.waybills',
    href: '/waybills',
    icon: 'waybill',
    section: '/waybills',
  },
  stock: { key: 'stock', label: 'nav.stock', href: '/stock', icon: 'store', section: '/stock' },
  processing: {
    key: 'processing',
    label: 'nav.processing',
    href: '/processing/new',
    icon: 'factory',
    section: '/processing',
  },
  qr: { key: 'qr', label: 'nav.qr', href: '/qr', icon: 'qr', section: '/qr' },
  labTests: {
    key: 'labTests',
    label: 'nav.labTests',
    short: 'navShort.labTests',
    href: '/lab/tests',
    icon: 'flask',
    section: '/lab',
  },
  recallTasks: {
    key: 'recallTasks',
    label: 'nav.recallTasks',
    short: 'navShort.recallTasks',
    href: '/recall-tasks',
    icon: 'check',
    section: '/recall-tasks',
  },
  recalls: { key: 'recalls', label: 'nav.recalls', href: '/recalls', icon: 'recall', section: '/recalls' },
  complaints: {
    key: 'complaints',
    label: 'nav.complaints',
    href: '/complaints',
    icon: 'alert',
    section: '/complaints',
  },
  reports: { key: 'reports', label: 'nav.reports', href: '/reports', icon: 'download', section: '/reports' },
  staff: { key: 'staff', label: 'nav.staff', href: '/org/staff', icon: 'users', section: '/org/staff' },
  organizations: {
    key: 'organizations',
    label: 'nav.organizations',
    href: '/admin/organizations',
    icon: 'building',
    section: '/admin/organizations',
  },
  users: {
    key: 'users',
    label: 'nav.adminUsers',
    href: '/admin/users',
    icon: 'shield',
    section: '/admin/users',
  },
  dictionaries: {
    key: 'dictionaries',
    label: 'nav.dictionaries',
    href: '/admin/dictionaries/products',
    icon: 'settings',
    section: '/admin/dictionaries',
  },
  audit: { key: 'audit', label: 'nav.audit', href: '/admin/audit', icon: 'eye', section: '/admin/audit' },
} satisfies Record<string, NavItem>;

type Key = keyof typeof ITEMS;

export const ROLE_NAV: Record<Role, readonly Key[]> = {
  FARMER: ['dashboard', 'fields', 'batches', 'waybills', 'recallTasks'],
  PROCESSOR: ['dashboard', 'waybills', 'stock', 'processing', 'batches', 'qr', 'recallTasks'],
  LAB: ['dashboard', 'labTests'],
  RETAILER: ['dashboard', 'waybills', 'stock', 'recallTasks', 'qr', 'batches'],
  INSPECTOR: ['dashboard', 'batches', 'recalls', 'complaints', 'fields', 'waybills', 'reports', 'audit'],
  ADMIN: ['dashboard', 'organizations', 'users', 'dictionaries', 'audit', 'reports'],
};

const ORG_ADMIN_NAV: readonly Key[] = ['staff', 'reports'];

export const PROFILE_ITEM: NavItem = {
  key: 'profile',
  label: 'nav.profile',
  href: '/profile',
  icon: 'user',
  section: '/profile',
};
export const NOTIFICATIONS_ITEM: NavItem = {
  key: 'notifications',
  label: 'nav.notifications',
  href: '/notifications',
  icon: 'bell',
  section: '/notifications',
};

function routeFor(href: string) {
  return CABINET_ROUTES.find((r) => r.path === href) ?? CABINET_ROUTES.find((r) => matchPath(r.path, href));
}

export function navFor(viewer: Viewer): NavItem[] {
  const keys: Key[] = [];
  for (const role of viewer.roles) for (const k of ROLE_NAV[role]) if (!keys.includes(k)) keys.push(k);
  if (viewer.isOrgAdmin) for (const k of ORG_ADMIN_NAV) if (!keys.includes(k)) keys.push(k);
  return keys
    .map((k) => ITEMS[k] as NavItem)
    .filter((item) => {
      const route = routeFor(item.href);
      return route ? canAccess(viewer, route.access) : false;
    });
}

export function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.section === '/') return pathname === '/';
  return pathname === item.section || pathname.startsWith(`${item.section}/`);
}
