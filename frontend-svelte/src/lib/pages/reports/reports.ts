import type { Schemas } from '@agrotrace/api-client';
import type { Role } from '../../app/access';

// Reports (FR-ANL-04, FR-ANL-05): which types a viewer may download (the contract's `x-report-access`) and the saved
// file name. As the React app (src/pages/reports.tsx there).

export type ReportType = Schemas['ReportType'];
export type ReportFormat = Schemas['ReportFormat'];

/** contract x-report-access of downloadReport (test/pages/reports.test.ts compares it with the contract). */
export const REPORT_ACCESS: Record<ReportType, { roles: readonly Role[]; headRoles: readonly Role[] }> = {
  batches: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'RETAILER'] },
  recalls: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  recall: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  'lab-tests': { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['LAB'] },
  complaints: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  org: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER'] },
};
const TYPES = Object.keys(REPORT_ACCESS) as ReportType[];

/** Types the viewer may download, and whether only as a head of organization (own organization). */
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

/** The file name of a `Content-Disposition: attachment; filename="…"` answer. */
export function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? '');
  return m?.[1] ?? fallback;
}
