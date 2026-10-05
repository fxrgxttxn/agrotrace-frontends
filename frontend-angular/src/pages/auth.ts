import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ApiProblem,
  type LoginResponse,
  type LoginSuccess,
  type Region,
  type RegisterOrganizationResponse,
} from '@agrotrace/api-client';
import { formatLocalTime } from '@agrotrace/i18n';
import {
  AcceptInviteRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterOrganizationRequestSchema,
  ResetPasswordRequestSchema,
  TwoFactorVerifyRequestSchema,
  type AcceptInviteRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterOrganizationRequest,
  type ResetPasswordRequest,
  type TwoFactorVerifyRequest,
} from '@agrotrace/validation';
import { call } from '../app/api';
import { FocusAfterWaitDirective, SchemaForm } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { FOREVER, injectQuery } from '../app/query';
import { injectAlive } from '../app/alive';
import { safeNext, SessionService } from '../app/session';
import { ToastService, UI } from '../app/ui';
import { AUTH_PAGE_HOST, CENTERED_ART, FORM_GRID, LINKS, submitButton } from './layout';

const IMPORTS = [...UI, ReactiveFormsModule, FocusAfterWaitDirective];

const isProblem = (e: unknown, code: string): e is ApiProblem => e instanceof ApiProblem && e.code === code;

function nextOf(route: ActivatedRoute): string {
  return safeNext(route.snapshot.queryParamMap.get('next'));
}

function searchOf(router: Router): string {
  const url = router.url;
  const i = url.indexOf('?');
  return i < 0 ? '' : url.slice(i);
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.login')"></div>
    <article class="at-card" [furrow]="true">
      <div class="at-card__body">
        <svg class="at-empty__art" [art]="'login'" style="${CENTERED_ART}"></svg>
        <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
          <div class="at-field" [fieldId]="'email'" [label]="t('field.email')" [error]="f.errorOf('email')">
            <input
              class="at-input"
              type="email"
              autocomplete="username"
              name="email"
              [formControl]="f.control('email')"
            />
          </div>
          <div
            class="at-field"
            [fieldId]="'password'"
            [label]="t('field.password')"
            [error]="f.errorOf('password')"
          >
            <input
              class="at-input"
              type="password"
              autocomplete="current-password"
              name="password"
              [formControl]="f.control('password')"
            />
          </div>
          ${submitButton('f', "t('action.login')")}
          <div style="${LINKS}">
            <a class="at-button" [variant]="'ghost'" [size]="'s'" [to]="'/password/forgot'">{{
              t('auth.forgot')
            }}</a>
            <a class="at-button" [variant]="'ghost'" [size]="'s'" [to]="'/register'">{{
              t('auth.register')
            }}</a>
          </div>
        </form>
      </div>
    </article>`,
})
export class LoginPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly f = new SchemaForm<LoginRequest>(LoginRequestSchema, { email: '', password: '' }, [
    'email',
    'password',
  ]);

  private readonly alive = injectAlive();

  protected readonly send = async (body: LoginRequest): Promise<void> => {
    let data: LoginResponse;
    try {
      data = await call<LoginResponse>(this.session.api.POST('/auth/login', { body }));
    } catch (e) {
      if (isProblem(e, 'ACCOUNT_LOCKED') && typeof e.params?.['lockedUntil'] === 'string')
        this.f.alert.show(t('auth.lockedUntil', { time: formatLocalTime(e.params['lockedUntil'], LOCALE) }));
      else this.f.fail(e);
      return;
    }
    if (data.twoFactorRequired) {
      if (this.alive())
        await this.router.navigateByUrl(`/login/2fa${searchOf(this.router)}`, {
          state: { challengeId: data.challengeId },
        });
      return;
    }
    this.session.signIn(data);
    if (this.alive()) await this.router.navigateByUrl(nextOf(this.route), { replaceUrl: true });
  };
}

export function challengeOf(router: Router, location: Location): string | null {
  const state = (router.getCurrentNavigation()?.extras.state ?? location.getState()) as {
    challengeId?: unknown;
  } | null;
  return typeof state?.challengeId === 'string' ? state.challengeId : null;
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.twoFactor')"></div>
    <article class="at-card">
      <div class="at-card__body">
        <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
          <div class="at-field" [fieldId]="'code'" [label]="t('auth.totpCode')" [error]="f.errorOf('code')">
            <input
              class="at-input at-mono"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              name="code"
              [formControl]="f.control('code')"
            />
          </div>
          ${submitButton('f', "t('auth.confirm')")}
          <div style="${LINKS}">
            <a class="at-button" [variant]="'ghost'" [size]="'s'" [to]="'/login' + search">{{
              t('auth.toLogin')
            }}</a>
          </div>
        </form>
      </div>
    </article>`,
})
export class TwoFactorPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  protected readonly search = searchOf(this.router);
  protected readonly f = new SchemaForm<TwoFactorVerifyRequest>(
    TwoFactorVerifyRequestSchema,
    { challengeId: challengeOf(this.router, inject(Location)) ?? '', code: '' },
    ['code'],
  );

  private readonly alive = injectAlive();

  private restart(): void {
    if (!this.alive()) return;
    this.toasts.push({ tone: 'danger', text: t('auth.challengeExpired') });
    void this.router.navigateByUrl(`/login${this.search}`, { replaceUrl: true });
  }

  protected readonly send = async (body: TwoFactorVerifyRequest): Promise<void> => {
    let data: LoginSuccess;
    try {
      data = await call<LoginSuccess>(this.session.api.POST('/auth/2fa/verify', { body }));
    } catch (e) {
      this.failed(e);
      return;
    }
    this.session.signIn(data);
    if (this.alive()) await this.router.navigateByUrl(nextOf(this.route), { replaceUrl: true });
  };

  private failed(e: unknown): void {
    {
      if (isProblem(e, 'INVALID_TWO_FACTOR_CODE')) {
        const left = Number(e.params?.['attemptsLeft']);
        if (left > 0) this.f.setError('code', t('auth.attemptsLeft', { count: left }));
        else this.restart();
      } else if (isProblem(e, 'TOKEN_EXPIRED') || (e instanceof ApiProblem && e.errors?.['challengeId']))
        this.restart();
      else this.f.fail(e);
    }
  }
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.passwordForgot')"></div>
    <article class="at-card">
      <div class="at-card__body">
        @if (sentTo(); as email) {
          <div style="${FORM_GRID}">
            <p>{{ t('auth.forgotSent', { email: email }) }}</p>
            <div>
              <a class="at-button" [to]="'/login'">{{ t('auth.toLogin') }}</a>
            </div>
          </div>
        } @else {
          <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
            <div class="at-field" [fieldId]="'email'" [label]="t('field.email')" [error]="f.errorOf('email')">
              <input
                class="at-input"
                type="email"
                autocomplete="email"
                name="email"
                [formControl]="f.control('email')"
              />
            </div>
            ${submitButton('f', "t('auth.sendLink')")}
            <div style="${LINKS}">
              <a class="at-button" [variant]="'ghost'" [size]="'s'" [to]="'/login'">{{
                t('auth.toLogin')
              }}</a>
            </div>
          </form>
        }
      </div>
    </article>`,
})
export class PasswordForgotPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  protected readonly sentTo = signal<string | null>(null);
  protected readonly f = new SchemaForm<ForgotPasswordRequest>(ForgotPasswordRequestSchema, { email: '' }, [
    'email',
  ]);

  protected readonly send = async (body: ForgotPasswordRequest): Promise<void> => {
    try {
      await call(this.session.api.POST('/auth/password/forgot', { body }));
      this.sentTo.set(body.email);
    } catch (e) {
      this.f.fail(e);
    }
  };
}

function tokenLooksValid(token: string | null): token is string {
  return token !== null && ResetPasswordRequestSchema.shape.token.safeParse(token).success;
}

const deadToken = (e: unknown) =>
  isProblem(e, 'TOKEN_EXPIRED') || (e instanceof ApiProblem && !!e.errors?.['token']);

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.passwordReset')"></div>
    <article class="at-card">
      <div class="at-card__body">
        @if (dead()) {
          <div style="${FORM_GRID}">
            <p>{{ t('auth.resetExpired') }}</p>
            <div>
              <a class="at-button" [to]="'/password/forgot'">{{ t('auth.requestNewLink') }}</a>
            </div>
          </div>
        } @else {
          <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
            <div
              class="at-field"
              [fieldId]="'password'"
              [label]="t('auth.newPassword')"
              [error]="f.errorOf('password')"
            >
              <input
                class="at-input"
                type="password"
                autocomplete="new-password"
                name="password"
                [formControl]="f.control('password')"
              />
            </div>
            ${submitButton('f', "t('auth.setPassword')")}
          </form>
        }
      </div>
    </article>`,
})
export class PasswordResetPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token');
  protected readonly dead = signal(!tokenLooksValid(this.token));
  protected readonly f = new SchemaForm<ResetPasswordRequest>(
    ResetPasswordRequestSchema,
    { token: this.token ?? '', password: '' },
    ['password'],
  );

  private readonly alive = injectAlive();

  protected readonly send = async (body: ResetPasswordRequest): Promise<void> => {
    try {
      await call(this.session.api.POST('/auth/password/reset', { body }));
    } catch (e) {
      if (deadToken(e)) this.dead.set(true);
      else this.f.fail(e);
      return;
    }
    this.toasts.push({ tone: 'ok', text: t('auth.resetDone') });
    if (this.alive()) await this.router.navigateByUrl('/login', { replaceUrl: true });
  };
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: AUTH_PAGE_HOST,
  template: `<div class="at-page__header" [pageTitle]="t('page.invite')"></div>
    <article class="at-card">
      <div class="at-card__body">
        @if (me(); as user) {
          <div style="${FORM_GRID}">
            <p>{{ t('auth.inviteSignedIn', { name: user.fullName }) }}</p>
            <div>
              <button class="at-button" [variant]="'primary'" [icon]="'logout'" (click)="signOut()">
                {{ t('action.logout') }}
              </button>
            </div>
          </div>
        } @else if (dead()) {
          <div style="${FORM_GRID}">
            <p>{{ t('auth.inviteExpired') }}</p>
            <div>
              <a class="at-button" [to]="'/login'">{{ t('auth.toLogin') }}</a>
            </div>
          </div>
        } @else {
          <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
            <div
              class="at-field"
              [fieldId]="'fullName'"
              [label]="t('field.fullName')"
              [error]="f.errorOf('fullName')"
            >
              <input
                class="at-input"
                autocomplete="name"
                name="fullName"
                [formControl]="f.control('fullName')"
              />
            </div>
            <div
              class="at-field"
              [fieldId]="'password'"
              [label]="t('field.password')"
              [error]="f.errorOf('password')"
            >
              <input
                class="at-input"
                type="password"
                autocomplete="new-password"
                name="password"
                [formControl]="f.control('password')"
              />
            </div>
            ${submitButton('f', "t('auth.acceptInvite')")}
          </form>
        }
      </div>
    </article>`,
})
export class InvitePage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token');
  protected readonly me = this.session.me;
  protected readonly dead = signal(!tokenLooksValid(this.token));
  protected readonly f = new SchemaForm<AcceptInviteRequest>(
    AcceptInviteRequestSchema,
    { token: this.token ?? '', fullName: '', password: '' },
    ['fullName', 'password'],
  );

  protected signOut(): void {
    void this.session.signOut(`/invite/${this.token ?? ''}`);
  }

  private readonly alive = injectAlive();

  protected readonly send = async (body: AcceptInviteRequest): Promise<void> => {
    try {
      await call(this.session.api.POST('/auth/accept-invite', { body }));
    } catch (e) {
      if (deadToken(e)) this.dead.set(true);
      else this.f.fail(e);
      return;
    }
    this.toasts.push({ tone: 'ok', text: t('auth.inviteDone') });
    if (this.alive()) await this.router.navigateByUrl('/login', { replaceUrl: true });
  };
}

const ORG_TYPES = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY'] as const;

const REGISTER_FIELDS = [
  'inn',
  'type',
  'name',
  'regionCode',
  'admin.email',
  'admin.fullName',
  'admin.password',
] as const;

interface RegisterValues extends Record<string, unknown> {
  inn: string;
  type: string;
  name: string;
  regionCode: string;
  admin: { email: string; fullName: string; password: string };
}

@Component({
  selector: 'main.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { id: 'main', tabindex: '-1', '[style.max-width]': "outcome() ? '30rem' : '40rem'" },
  template: `<div class="at-page__header" [pageTitle]="t('page.register')"></div>
    @if (outcome(); as status) {
      <article class="at-card">
        <div class="at-card__body">
          <div style="${FORM_GRID}">
            <p>{{ t(status === 'MANUAL_CHECK' ? 'auth.registerManual' : 'auth.registerPending') }}</p>
            <div>
              <a class="at-button" [to]="'/login'">{{ t('auth.toLogin') }}</a>
            </div>
          </div>
        </div>
      </article>
    } @else {
      <form novalidate style="${FORM_GRID}" (submit)="f.submit($event, send)">
        <article class="at-card">
          <header class="at-card__header" [cardTitle]="t('auth.organization')"></header>
          <div class="at-card__body">
            <div style="${FORM_GRID}">
              <div class="at-field" [fieldId]="'inn'" [label]="t('field.inn')" [error]="f.errorOf('inn')">
                <input
                  class="at-input at-mono"
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength="12"
                  name="inn"
                  [formControl]="f.control('inn')"
                />
              </div>
              <div
                class="at-field"
                [fieldId]="'type'"
                [label]="t('auth.orgType')"
                [error]="f.errorOf('type')"
              >
                <select class="at-select" name="type" [formControl]="f.control('type')">
                  @for (type of orgTypes; track type) {
                    <option [value]="type">{{ t('orgType.' + type) }}</option>
                  }
                </select>
              </div>
              <div class="at-field" [fieldId]="'name'" [label]="t('field.name')" [error]="f.errorOf('name')">
                <input
                  class="at-input"
                  autocomplete="organization"
                  name="name"
                  [formControl]="f.control('name')"
                />
              </div>
              <div
                class="at-field"
                [fieldId]="'regionCode'"
                [label]="t('field.regionCode')"
                [error]="f.errorOf('regionCode')"
              >
                <select class="at-select" name="regionCode" [formControl]="f.control('regionCode')">
                  <option value="">{{ t('auth.chooseRegion') }}</option>
                  @for (r of regions(); track r.code) {
                    <option [value]="r.code">{{ r.name }}</option>
                  }
                </select>
              </div>
              @if (regionsFailed()) {
                <div style="${LINKS}">
                  <p role="alert">{{ t('auth.regionsFailed') }}</p>
                  <button class="at-button" [size]="'s'" [busy]="regionsBusy()" (click)="loadRegions()">
                    {{ t('action.retry') }}
                  </button>
                </div>
              }
            </div>
          </div>
        </article>
        <article class="at-card">
          <header class="at-card__header" [cardTitle]="t('auth.head')"></header>
          <div class="at-card__body">
            <div style="${FORM_GRID}">
              <div
                class="at-field"
                [fieldId]="'admin-email'"
                [label]="t('field.email')"
                [error]="f.errorOf('admin.email')"
              >
                <input
                  class="at-input"
                  type="email"
                  autocomplete="email"
                  name="admin.email"
                  [formControl]="f.control('admin.email')"
                />
              </div>
              <div
                class="at-field"
                [fieldId]="'admin-fullName'"
                [label]="t('field.fullName')"
                [error]="f.errorOf('admin.fullName')"
              >
                <input
                  class="at-input"
                  autocomplete="name"
                  name="admin.fullName"
                  [formControl]="f.control('admin.fullName')"
                />
              </div>
              <div
                class="at-field"
                [fieldId]="'admin-password'"
                [label]="t('field.password')"
                [error]="f.errorOf('admin.password')"
              >
                <input
                  class="at-input"
                  type="password"
                  autocomplete="new-password"
                  name="admin.password"
                  [formControl]="f.control('admin.password')"
                />
              </div>
            </div>
          </div>
          <footer class="at-card__footer">
            ${submitButton('f', "t('action.register')")}
            <a class="at-button" [variant]="'ghost'" [to]="'/login'">{{ t('auth.toLogin') }}</a>
          </footer>
        </article>
      </form>
    }`,
})
export class RegisterPage {
  protected readonly t = t;
  protected readonly orgTypes = ORG_TYPES;
  private readonly session = inject(SessionService);
  protected readonly outcome = signal<RegisterOrganizationResponse['status'] | null>(null);
  private readonly regionsQuery = injectQuery(
    () => ({ key: 'public/regions', load: () => call<Region[]>(this.session.api.GET('/public/regions')) }),
    { freshMs: FOREVER },
  );
  protected readonly regions = computed(() => this.regionsQuery.data() ?? []);
  protected readonly regionsBusy = this.regionsQuery.fetching;
  protected readonly regionsFailed = this.regionsQuery.failed;
  protected readonly f = new SchemaForm<RegisterValues, RegisterOrganizationRequest>(
    RegisterOrganizationRequestSchema,
    {
      inn: '',
      type: 'FARM',
      name: '',
      regionCode: '',
      admin: { email: '', fullName: '', password: '' },
    },
    REGISTER_FIELDS,
    { toWire: ({ name, ...rest }) => (name === '' ? rest : { ...rest, name }) },
  );

  protected loadRegions(): void {
    void this.regionsQuery.refetch();
  }

  protected readonly send = async (body: RegisterOrganizationRequest): Promise<void> => {
    try {
      const res = await call<RegisterOrganizationResponse>(
        this.session.api.POST('/auth/register-organization', { body }),
      );
      this.outcome.set(res.status);
    } catch (e) {
      this.f.fail(e);
    }
  };
}
