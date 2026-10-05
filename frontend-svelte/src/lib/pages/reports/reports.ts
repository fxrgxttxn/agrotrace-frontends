import type { Schemas } from '@agrotrace/api-client';
import type { Role } from '../../app/access';

export type ReportType = Schemas['ReportType'];
export type ReportFormat = Schemas['ReportFormat'];

export const REPORT_ACCESS: Record<ReportType, { roles: readonly Role[]; headRoles: readonly Role[] }> = {
  batches: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'RETAILER'] },
  recalls: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  recall: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  'lab-tests': { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['LAB'] },
  complaints: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  org: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER'] },
};
const TYPES = Object.keys(REPORT_ACCESS) as ReportType[];

export function reportTypes(
  roles: readonly Role[],
  isOrgAdmin: boolean,
): { type: ReportType; head: boolean }[] {
  return TYPES.flatMap((type): { type: ReportType; head: boolean }[] => {
    const a = REPORT_ACCESS[type];
    if (roles.some((r) => a.roles.includes(r))) return [{ type, head: false }];
    if (isOrgAdmin && roles.some((r) => a.headRoles.includes(r))) return [{ type, head: true }];
    return [];
  });
}

export function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? '');
  return m?.[1] ?? fallback;
}
