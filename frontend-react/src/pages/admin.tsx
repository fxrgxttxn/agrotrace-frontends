import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function ReportsPage() {
  return <Page title={t('page.reports')} />;
}

export function StaffPage() {
  return <Page title={t('page.staff')} />;
}

export function OrganizationsPage() {
  return <Page title={t('page.organizations')} />;
}

export function UsersPage() {
  return <Page title={t('page.users')} />;
}

export function DictionaryPage() {
  return <Page title={t('page.dictionaries')} />;
}

export function AuditPage() {
  return <Page title={t('page.audit')} />;
}
