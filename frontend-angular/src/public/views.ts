import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  InjectionToken,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import recallWarning from '@agrotrace/design-system/illustrations/recall-warning.svg';
import emptySearch from '@agrotrace/design-system/illustrations/empty-search.svg';
import { ArtDirective, parseArt, type ParsedArt } from './art';
import type { Failure } from './data';
import { t } from './i18n';
import { countdown, focusAfterWait } from './wait';

export const ART = {
  recallWarning: parseArt(recallWarning)!,
  emptySearch: parseArt(emptySearch)!,
} satisfies Record<string, ParsedArt>;

export const HEADER = `<div class="at-page__header"><h1 class="at-page__title" tabindex="-1">{{ title() }}</h1></div>`;

export const LOADING = `<div class="at-card" data-furrow="" aria-busy="true">
          <div class="at-card__body at-public__loading">
            <span class="at-visually-hidden">{{ t('shell.loading') }}</span>
            <span class="at-skeleton" data-shape="block"></span>
            <span class="at-skeleton" data-shape="text" style="width: 60%"></span>
            <span class="at-skeleton" data-shape="text" style="width: 40%"></span>
          </div>
        </div>`;

export const NOT_FOUND = `<article class="at-card" data-furrow="">
          <div class="at-empty">
            <svg class="at-empty__art" aria-hidden="true" [atArt]="art.emptySearch"></svg>
            <p class="at-empty__text">{{ t('public.notFound') }}</p>
          </div>
        </article>`;

export const ARRIVALS = new InjectionToken<{ first: boolean }>('public page arrivals');

export function arrivalFocus(): void {
  const arrivals = inject(ARRIVALS, { optional: true });
  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  afterNextRender(() => {
    if (!arrivals) return;
    if (arrivals.first) {
      arrivals.first = false;
      return;
    }
    window.scrollTo(0, 0);
    host.querySelector<HTMLElement>('h1.at-page__title')?.focus();
  });
}

export function titleEffect(title: () => string): void {
  effect(() => {
    const value = title();
    untracked(() => (document.title = `${value} — AgroTrace`));
  });
}

const FAILURE_TEXT: Record<Failure['kind'], string> = {
  offline: 'public.offline',
  unavailable: 'public.unavailable',
  limited: 'errors.RATE_LIMITED',
};

@Component({
  selector: 'article[atFailed]',
  standalone: true,
  imports: [ArtDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-empty">
    <svg class="at-empty__art" aria-hidden="true" [atArt]="art.emptySearch"></svg>
    <p class="at-empty__text">{{ t(text[atFailed().kind]) }}</p>
    <!-- prettier-ignore -->
    <button #retry class="at-button" type="button" data-variant="primary" [attr.aria-busy]="busy() ? 'true' : null" [disabled]="wait.left() > 0" (click)="busy() ? null : retried.emit()">{{ wait.left() > 0 ? t('auth.retryIn', { seconds: wait.left() }) : t('action.retry') }}</button>
  </div>`,
})
export class FailedComponent {
  protected readonly t = t;
  protected readonly art = ART;
  protected readonly text = FAILURE_TEXT;
  readonly atFailed = input.required<Failure>();
  readonly busy = input(false);
  readonly retried = output<void>();
  protected readonly wait = countdown();
  private readonly retry = viewChild<ElementRef<HTMLElement>>('retry');

  constructor() {
    effect(() => {
      const f = this.atFailed();
      if (f.kind === 'limited') untracked(() => this.wait.start(f.wait));
    });
    focusAfterWait(this.wait.left, () => this.retry());
  }
}
