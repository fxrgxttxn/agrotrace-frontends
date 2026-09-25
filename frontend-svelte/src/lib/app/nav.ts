import type { IconName } from '../ui/icons';
import { canAccess, type Role, type Viewer } from './access';
import { cabinetRoute } from './routes';

export interface NavItem {
  key: string;
  /** i18n key of the label. */
  label: string;
  href: string;
  icon: IconName;
  /** Path prefix of the section (`aria-current="page"` for it and its nested routes). */
  section: string;
}

// The same items, icons (README «Иконки разделов», ruling F6) and order as the React app.
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
  labTests: { key: 'labTests', label: 'nav.labTests', href: '/lab/tests', icon: 'flask', section: '/lab' },
  recallTasks: {
    key: 'recallTasks',
    label: 'nav.recallTasks',
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

/** Menu of each role (spec §9.5), most used first: the first four also form the bottom navigation (< 768 px). */
export const ROLE_NAV: Record<Role, readonly Key[]> = {
  FARMER: ['dashboard', 'fields', 'batches', 'waybills', 'recallTasks'],
  PROCESSOR: ['dashboard', 'waybills', 'stock', 'processing', 'batches', 'qr', 'recallTasks'],
  LAB: ['dashboard', 'labTests'],
  RETAILER: ['dashboard', 'waybills', 'stock', 'recallTasks', 'qr', 'batches'],
  INSPECTOR: ['dashboard', 'batches', 'recalls', 'complaints', 'fields', 'waybills', 'reports', 'audit'],
  ADMIN: ['dashboard', 'organizations', 'users', 'dictionaries', 'audit', 'reports'],
};

/** Head of organization, in addition (§9.5): staff and organization reports. */
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

/** How many role items the bottom bar holds before «Ещё» (spec §9.3). */
export const BOTTOM_NAV_ITEMS = 4;

/** Menu items of a viewer: the union of their roles' menus (in role order), plus the head-of-organization items,
 * each one only if its route lets the viewer in. */
export function navFor(viewer: Viewer): NavItem[] {
  const keys: Key[] = [];
  for (const role of viewer.roles) for (const k of ROLE_NAV[role]) if (!keys.includes(k)) keys.push(k);
  if (viewer.isOrgAdmin) for (const k of ORG_ADMIN_NAV) if (!keys.includes(k)) keys.push(k);
  return keys
    .map((k) => ITEMS[k] as NavItem)
    .filter((item) => {
      const route = cabinetRoute(item.href);
      return route ? canAccess(viewer, route.access) : false;
    });
}

/** `aria-current="page"` rule: the section itself and everything under it; the dashboard only at `/`. */
export function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.section === '/') return pathname === '/';
  return pathname === item.section || pathname.startsWith(`${item.section}/`);
}
