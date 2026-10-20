import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function FieldsPage() {
  return <Page title={t('page.fields')} />;
}

export function FieldNewPage() {
  return <Page title={t('page.fieldNew')} />;
}

export function FieldPage() {
  return <Page title={t('page.field')} />;
}
