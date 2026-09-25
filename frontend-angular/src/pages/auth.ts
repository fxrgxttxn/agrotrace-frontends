import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { problemMessage } from '@agrotrace/i18n';
import { t } from '../app/i18n';
import { safeNext, SessionService } from '../app/session';
import { UI, ToastService } from '../app/ui';
import { AUTH_PAGE_HOST } from './layout';

type LoginResponse = Schemas['LoginResponse'];

/** Field errors of a 400 VALIDATION problem (`errors: {field: [i18n key…]}`) — first message per field. */
export function fieldErrors(p: ApiProblem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, keys] of Object.entries(p.errors ?? {})) if (keys[0]) out[field] = t(keys[0]);
  return out;
}

/** `/login` — email and password; TOTP users continue on `/login/2fa` (the full form arrives with A2). */
@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.login')"></div>
    <article class="at-card" [furrow]="true">
      <div class="at-card__body">
        <svg class="at-empty__art" [art]="'login'" style="display: block; margin-inline: auto"></svg>
        <form novalidate style="display: grid; gap: var(--sp-4)" (submit)="submit($event)">
          <div class="at-field" [fieldId]="'email'" [label]="t('field.email')" [error]="errors()['email']">
            <input
              class="at-input"
              type="email"
              name="email"
              autocomplete="username"
              [value]="email()"
              (input)="email.set($any($event.target).value)"
            />
          </div>
          <div
            class="at-field"
            [fieldId]="'password'"
            [label]="t('field.password')"
            [error]="errors()['password']"
          >
            <input
              class="at-input"
              type="password"
              name="password"
              autocomplete="current-password"
              [value]="password()"
              (input)="password.set($any($event.target).value)"
            />
          </div>
          <button class="at-button" [type]="'submit'" [variant]="'primary'" [busy]="busy()">
            {{ t('action.login') }}
          </button>
        </form>
      </div>
    </article>`,
})
export class LoginPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly errors = signal<Record<string, string>>({});

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy()) return;
    const email = this.email().trim();
    const password = this.password();
    const missing: Record<string, string> = {};
    if (!email) missing['email'] = t('validation.required');
    if (!password) missing['password'] = t('validation.required');
    this.errors.set(missing);
    if (Object.keys(missing).length) return;
    this.busy.set(true);
    try {
      const res = await this.session.api.POST('/auth/login', { body: { email, password } });
      if (res.error !== undefined) throw new ApiProblem(res.error as never, res.response.status);
      const data = res.data as LoginResponse;
      if (data.twoFactorRequired) {
        await this.router.navigate(['/login/2fa'], {
          queryParamsHandling: 'preserve',
          state: { challengeId: data.challengeId },
        });
        return;
      }
      this.session.signIn(data);
      await this.router.navigateByUrl(safeNext(this.route.snapshot.queryParamMap.get('next')), {
        replaceUrl: true,
      });
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors)
        this.errors.set(fieldErrors(err));
      else
        this.toasts.push({
          tone: 'danger',
          text: err instanceof ApiProblem ? problemMessage(err, t) : t('errors.BACKEND_UNAVAILABLE'),
        });
    } finally {
      this.busy.set(false);
    }
  }
}

// Placeholders of the screens (the task that owns each screen replaces them).
const PLACEHOLDER = `<div class="at-page__header" [pageTitle]="title"></div>
  <article class="at-card"><div class="at-card__body"></div></article>`;

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: PLACEHOLDER,
})
export class TwoFactorPage {
  protected readonly title = t('page.twoFactor');
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: PLACEHOLDER,
})
export class PasswordForgotPage {
  protected readonly title = t('page.passwordForgot');
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: PLACEHOLDER,
})
export class PasswordResetPage {
  protected readonly title = t('page.passwordReset');
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: PLACEHOLDER,
})
export class RegisterPage {
  protected readonly title = t('page.register');
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: PLACEHOLDER,
})
export class InvitePage {
  protected readonly title = t('page.invite');
}
