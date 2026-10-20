import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function RecallTasksPage() {
  return <Page title={t('page.recallTasks')} />;
}

export function RecallsPage() {
  return <Page title={t('page.recalls')} />;
}

export function RecallNewPage() {
  return <Page title={t('page.recallNew')} />;
}

export function RecallPage() {
  return <Page title={t('page.recall')} />;
}
