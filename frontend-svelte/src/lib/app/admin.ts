import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { formatBytes } from '@agrotrace/i18n';
import machines from '../../../../contracts/rules/entity-state-machines.json';
import { LOCALE, t } from './i18n';
import type { Role } from './access';
import type { Tone } from '../ui/display';

type OrgStatus = Schemas['OrganizationStatus'];
type OrgType = Schemas['OrganizationType'];
type UserStatus = Schemas['UserStatus'];

export const ORG_TONE: Record<OrgStatus, Tone> = {
  PENDING: 'attention',
  MANUAL_CHECK: 'attention',
  ACTIVE: 'ok',
  REJECTED: 'neutral',
  SUSPENDED: 'danger',
};
export const USER_TONE: Record<UserStatus, Tone> = { INVITED: 'attention', ACTIVE: 'ok', BLOCKED: 'danger' };

export const APPLICATION: readonly OrgStatus[] = ['PENDING', 'MANUAL_CHECK'];

export type OrgAction = 'approve' | 'reject' | 'suspend' | 'resume';

export function orgActions(status: OrgStatus, type: OrgType): OrgAction[] {
  if (type === 'PLATFORM') return [];
  return machines.organization.transitions
    .filter((x) => x.from === status && x.by !== 'system')
    .map((x) => x.action as OrgAction);
}

export function orgTarget(action: OrgAction): OrgStatus {
  return machines.organization.transitions.find((x) => x.action === action)!.to as OrgStatus;
}

export const ROLE_OF_TYPE: Record<OrgType, Role> = {
  FARM: 'FARMER',
  PROCESSOR: 'PROCESSOR',
  LAB: 'LAB',
  RETAILER: 'RETAILER',
  AUTHORITY: 'INSPECTOR',
  PLATFORM: 'ADMIN',
};

export const UPLOAD_MAX_BYTES = 5242880;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_TYPES = ['text/csv', XLSX];
export const IMPORT_ACCEPT = `.csv,.xlsx,text/csv,${XLSX}`;

const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'text/csv': 'CSV',
  [XLSX]: 'XLSX',
};
export const typesText = (types: readonly unknown[]) =>
  types.map((m) => TYPE_NAMES[String(m)] ?? String(m)).join(', ');
export const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });

export function isImportFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.xlsx') || file.type === 'text/csv' || file.type === XLSX;
}

export type DictName = Schemas['DictionaryName'];
export const DICTIONARIES: readonly DictName[] = ['products', 'substances', 'indicators', 'norms', 'regions'];

export const IMPORT_HEADER: Record<DictName, string> = {
  products: 'name;category;lossNormPercent',
  substances: 'name;type;waitingPeriodDays',
  indicators: 'name;unit',
  norms: 'product;indicator;maxValue',
  regions: 'code;name',
};

export function importFileProblem(e: unknown, name: DictName): string | null {
  if (!(e instanceof ApiProblem)) return null;
  if (e.code === 'FILE_TOO_LARGE')
    return t('dict.import.tooLarge', {
      max: formatBytes(Number(e.params?.maxBytes) || UPLOAD_MAX_BYTES, LOCALE),
    });
  if (e.code === 'UNSUPPORTED_MEDIA_TYPE')
    return e.params?.reason === 'workbook-too-large'
      ? t('dict.import.workbookTooLarge')
      : t('dict.import.notWorkbook');
  const key = e.code === 'VALIDATION' ? e.errors?.file?.[0] : undefined;
  if (key === 'validation.import.header') return t('dict.import.header', { header: IMPORT_HEADER[name] });
  if (key === 'validation.import.format') return t('dict.import.format');
  if (key === 'validation.import.tooManyRows') return t('dict.import.tooManyRows');
  if (key) return t(key);
  return null;
}
