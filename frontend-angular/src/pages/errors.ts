import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { countdown } from '../app/api';
import { t } from '../app/i18n';
import { SessionService } from '../app/session';
import { UI } from '../app/ui';
import { AUTH_PAGE_HOST } from './layout';

// 403 and 404: inside the shell for a signed-in user (the illustration on a card: it stands on --c-surface only),
// standalone otherwise (README «Страница»). The «Сервис недоступен» screen (R61/F8): a transient failure of the
// start-up restore — a retry, never a logout; after a 429 the retry waits out Retry-After.

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.forbidden')"></div>
    <article class="at-card">
      <div class="at-empty" [art]="'forbidden'" [text]="t('empty.forbidden')">
        <a class="at-button" [variant]="'primary'" [to]="'/'">{{ t('action.home') }}</a>
      </div>
    </article>`,
})
export class ForbiddenPage {
  protected readonly t = t;
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.notFound')"></div>
    <article class="at-card">
      <div class="at-empty" [art]="'not-found'" [text]="t('empty.notFound')">
        <a class="at-button" [variant]="'primary'" [to]="'/'">{{ t('action.home') }}</a>
      </div>
    </article>`,
})
export class NotFoundPage {
  protected readonly t = t;
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.forbidden')"></div>
    <article class="at-card">
      <div class="at-card__body">
        <div class="at-empty" [art]="'forbidden'" [text]="t('empty.forbidden')">
          <a class="at-button" [variant]="'primary'" [to]="'/login'">{{ t('action.login') }}</a>
        </div>
      </div>
    </article>`,
})
export class ForbiddenStandalonePage {
  protected readonly t = t;
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.notFound')"></div>
    <article class="at-card">
      <div class="at-card__body">
        <div class="at-empty" [art]="'not-found'" [text]="t('empty.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/login'">{{ t('action.login') }}</a>
        </div>
      </div>
    </article>`,
})
export class NotFoundStandalonePage {
  protected readonly t = t;
}

/** A cabinet route while the session cannot be restored for a transient reason (R61, F8). */
@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { ...AUTH_PAGE_HOST, '[attr.aria-busy]': "session.status() === 'loading' ? 'true' : null" },
  template: `<div class="at-page__header" [pageTitle]="t('page.unavailable')"></div>
    <article class="at-card">
      <div class="at-card__body">
        <div class="at-empty" [art]="'empty-search'" [text]="text()">
          <button
            #retryButton
            class="at-button"
            [variant]="'primary'"
            [disabled]="wait.left() > 0 || session.status() === 'loading'"
            (click)="retry()"
          >
            {{ wait.left() > 0 ? t('auth.retryIn', { seconds: wait.left() }) : t('action.retry') }}
          </button>
        </div>
      </div>
    </article>`,
})
export class UnavailablePage {
  protected readonly t = t;
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly wait = countdown();
  private readonly retryButton = viewChild('retryButton', { read: ElementRef<HTMLButtonElement> });

  constructor() {
    // Every new «unavailable» answer with a Retry-After starts the wait (also after a retry on this same page).
    effect(
      () => {
        const s = this.session.state();
        if (s.status === 'unavailable' && s.retryAfter) {
          const seconds = s.retryAfter;
          untracked(() => this.wait.start(seconds));
        }
      },
      { allowSignalWrites: true },
    );
    // A disabled button drops the focus: when the wait is over, the focus goes to the button that can act now.
    let waited = false;
    effect(() => {
      if (this.wait.left() > 0) waited = true;
      else if (waited) {
        waited = false;
        afterNextRender(() => this.retryButton()?.nativeElement.focus(), { injector: this.injector });
      }
    });
  }

  protected text(): string {
    const s = this.session.state();
    return s.status === 'unavailable' && s.retryAfter
      ? t('errors.RATE_LIMITED')
      : t('errors.BACKEND_UNAVAILABLE');
  }

  protected async retry(): Promise<void> {
    await this.session.restore();
    // Run the guards of this URL again (into the shell with its role guard, to the login, or back here with a new
    // wait) — a deep link of another role ends on /403 exactly as after a normal start.
    await this.router.navigateByUrl(this.router.url, { onSameUrlNavigation: 'reload' });
  }
}
