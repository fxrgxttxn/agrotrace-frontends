import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function LabTestsPage() {
  return <Page title={t('page.labTests')} />;
}

export function LabTestPage() {
  return <Page title={t('page.labTest')} />;
}
