import type { Schemas } from '@agrotrace/api-client';

export type Role = Schemas['RoleCode'];

export interface Viewer {
  roles: readonly Role[];
  isOrgAdmin: boolean;
}

export type Access = 'auth' | { roles: readonly Role[]; orgAdmin?: boolean };

export const ALL_ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

export function canAccess(viewer: Viewer, access: Access): boolean {
  if (access === 'auth') return true;
  if (access.orgAdmin && viewer.isOrgAdmin) return true;
  return viewer.roles.some((r) => access.roles.includes(r));
}
