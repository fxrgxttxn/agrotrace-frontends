import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { ArtDirective } from './art';
import { BatchPageComponent } from './batch-page';
import { ComplaintPageComponent } from './complaint-page';
import { t } from './i18n';
import { matchPublic, path } from './nav';
import { ARRIVALS, ART, arrivalFocus, HEADER, NOT_FOUND, titleEffect } from './views';

@Component({
  selector: 'main[atNoPage]',
  standalone: true,
  imports: [ArtDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'at-page at-public', id: 'main', tabindex: '-1' },
  template: `${HEADER}
    <div class="at-public__stack">${NOT_FOUND}</div>`,
})
export class NoPageComponent {
  protected readonly t = t;
  protected readonly art = ART;
  protected readonly title = signal(t('page.publicBatch'));
  constructor() {
    titleEffect(this.title);
    arrivalFocus();
  }
}

@Component({
  selector: 'at-root',
  standalone: true,
  imports: [BatchPageComponent, ComplaintPageComponent, NoPageComponent],
  providers: [{ provide: ARRIVALS, useFactory: () => ({ first: true }) }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (route().name) {
    @case ('batch') {
      @for (c of [code()]; track c) {
        <main [batchPage]="c"></main>
      }
    }
    @case ('complaint') {
      @for (c of [code()]; track c) {
        <main [complaintPage]="c"></main>
      }
    }
    @default {
      <main atNoPage></main>
    }
  }`,
})
export class PublicApp {
  protected readonly route = computed(() => matchPublic(path()));
  protected readonly code = computed(() => {
    const r = this.route();
    return r.name === 'none' ? '' : r.code;
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    queueMicrotask(() => host.removeAttribute('ng-version'));
    path.set(location.pathname);
    const sync = () => path.set(location.pathname);
    window.addEventListener('popstate', sync);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('popstate', sync));
  }
}
