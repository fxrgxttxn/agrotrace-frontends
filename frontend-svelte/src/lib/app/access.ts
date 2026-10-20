import type { Schemas } from '@agrotrace/api-client';

export type Role = Schemas['RoleCode'];

/** What the UI needs to know about the signed-in user to decide on routes and menu items (from `GET /me`). */
export interface Viewer {
  roles: readonly Role[];
  isOrgAdmin: boolean;
}

/** `auth` — any signed-in user; otherwise one of `roles`, or (`orgAdmin`) a head of organization of any role. */
export type Access = 'auth' | { roles: readonly Role[]; orgAdmin?: boolean };

export const ALL_ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

export function canAccess(viewer: Viewer, access: Access): boolean {
  if (access === 'auth') return true;
  if (access.orgAdmin && viewer.isOrgAdmin) return true;
  return viewer.roles.some((r) => access.roles.includes(r));
}
