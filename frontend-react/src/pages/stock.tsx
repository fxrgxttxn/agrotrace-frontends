import { t } from '../app/i18n';
import { Page } from '../ui';

// Placeholders of the screens (Plan 2: the task that owns each screen replaces them).

export function StockPage() {
  return <Page title={t('page.stock')} />;
}

export function ProcessingPage() {
  return <Page title={t('page.processing')} />;
}

export function QrPage() {
  return <Page title={t('page.qr')} />;
}
