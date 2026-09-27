/** The one role of each organization type (UserInvite / UserPatch: FARM→FARMER, …, PLATFORM→ADMIN; R37). */
import type { RoleCode } from '../../security/jwt.js';

export const ROLE_OF_TYPE: Record<string, RoleCode> = {
  FARM: 'FARMER',
  PROCESSOR: 'PROCESSOR',
  LAB: 'LAB',
  RETAILER: 'RETAILER',
  AUTHORITY: 'INSPECTOR',
  PLATFORM: 'ADMIN',
};

/** Roles are valid for an organization of `type` only as exactly its one role. */
export const rolesFitType = (roles: readonly string[], type: string): boolean =>
  roles.length === 1 && roles[0] === ROLE_OF_TYPE[type];
