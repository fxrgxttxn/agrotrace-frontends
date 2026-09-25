import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function BatchesPage() {
  return <Page title={t('page.batches')} />;
}

export function BatchNewPage() {
  return <Page title={t('page.batchNew')} />;
}

export function BatchPage() {
  return <Page title={t('page.batch')} />;
}
