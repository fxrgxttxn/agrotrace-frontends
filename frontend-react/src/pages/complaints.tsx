import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function ComplaintsPage() {
  return <Page title={t('page.complaints')} />;
}

export function ComplaintPage() {
  return <Page title={t('page.complaint')} />;
}
