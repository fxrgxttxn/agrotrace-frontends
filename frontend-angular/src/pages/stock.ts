import { ChangeDetectionStrategy, Component } from '@angular/core';
import { t } from '../app/i18n';
import { PageHeaderComponent } from '../app/ui';

// Placeholders of the screens (Plan 4: the task that owns each screen replaces them). The host is the page itself.
const TEMPLATE = `<div class="at-page__header" [pageTitle]="title"></div>`;

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class StockPage {
  protected readonly title = t('page.stock');
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class ProcessingPage {
  protected readonly title = t('page.processing');
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class QrPage {
  protected readonly title = t('page.qr');
}
