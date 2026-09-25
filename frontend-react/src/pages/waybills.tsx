import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function WaybillsPage() {
  return <Page title={t('page.waybills')} />;
}

export function WaybillNewPage() {
  return <Page title={t('page.waybillNew')} />;
}

export function WaybillPage() {
  return <Page title={t('page.waybill')} />;
}
