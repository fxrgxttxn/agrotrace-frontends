import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import {
  ApiProblem,
  withVariant,
  type Me,
  type NotificationChannels,
  type TelegramCode,
  type TwoFactorSetupResponse,
} from '@agrotrace/api-client';
import { formatBytes, formatLocalTime } from '@agrotrace/i18n';
import {
  MeUpdateSchema,
  TwoFactorSetupRequestSchema,
  type MeUpdate,
  type TwoFactorSetupRequest,
} from '@agrotrace/validation';
import { injectLive } from '../app/alive';
import { call, countdown, retryAfterOf } from '../app/api';
import { actionOrigin, restoreFocus, type ActionOrigin } from '../app/focus';
import { FocusAfterWaitDirective, formAlert, SchemaForm } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { injectQuery } from '../app/query';
import { SessionService } from '../app/session';
import { ThemeSwitchComponent } from '../app/shell/theme-switch';
import {
  ButtonComponent,
  CardHeaderComponent,
  PageHeaderComponent,
  ToastService,
  UI,
  type CardFact,
  type FileItem,
} from '../app/ui';
import { QrComponent } from '../app/ui/qr';
import { FORM_GRID, submitButton } from './layout';

const GRID =
  'display: grid; gap: var(--sp-6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr)); align-items: start';
const ROW = 'display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center';

const IMPORTS = [...UI, ReactiveFormsModule, FocusAfterWaitDirective];

interface PersonalValues extends Record<string, unknown> {
  fullName: string;
  phone: string | null;
}

@Component({
  selector: 'article.at-card[personal]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="at-card__header" [cardTitle]="t('profile.personal')"></header>
    <form novalidate (submit)="f.submit($event, send)">
      <div class="at-card__body">
        <div style="${FORM_GRID}">
          <dl class="at-card__facts" [facts]="facts()"></dl>
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
          <div class="at-field" [fieldId]="'phone'" [label]="t('field.phone')" [error]="f.errorOf('phone')">
            <input
              class="at-input"
              type="tel"
              inputmode="tel"
              autocomplete="tel"
              name="phone"
              [formControl]="f.control('phone')"
            />
          </div>
        </div>
      </div>
      <footer class="at-card__footer">${submitButton('f', "t('action.save')")}</footer>
    </form>`,
})
export class PersonalCardComponent {
  protected readonly t = t;
  readonly personal = input.required<Me>();
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly live = injectLive();
  protected readonly facts = computed<CardFact[]>(() => {
    const me = this.personal();
    return [
      { key: 'email', term: t('field.email'), value: me.email },
      { key: 'org', term: t('auth.organization'), value: me.organization.name },
      { key: 'roles', term: t('field.roles'), value: me.roles.map((r) => t(`role.${r}`)).join(', ') },
    ];
  });
  private readonly start = this.session.me()!;
  protected readonly f = new SchemaForm<PersonalValues, MeUpdate>(
    MeUpdateSchema,
    { fullName: this.start.fullName, phone: this.start.phone ?? null },
    ['fullName', 'phone'],
    { toWire: (v) => ({ fullName: v.fullName, phone: v.phone === '' ? null : v.phone }) },
  );

  protected readonly send = async (values: MeUpdate): Promise<void> => {
    const me = this.personal();
    const body: MeUpdate = {};
    if (values.fullName !== me.fullName) body.fullName = values.fullName;
    if (values.phone !== me.phone) body.phone = values.phone;
    if (Object.keys(body).length === 0) return;
    const generation = this.session.generation;
    let next: Me;
    try {
      next = await call<Me>(this.session.api.PATCH('/me', { body }));
    } catch (e) {
      if (this.live(generation)) this.f.fail(e);
      return;
    }
    this.session.setMe(next, generation);
    if (generation === this.session.generation) this.toasts.push({ tone: 'ok', text: t('profile.saved') });
    if (!this.live(generation)) return;
    this.f.reset({ fullName: next.fullName, phone: next.phone ?? null });
  };
}

const AVATAR_MAX_BYTES = 2097152;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
  'application/pdf': 'PDF',
};

const typesText = (types: readonly unknown[]) =>
  types.map((m) => TYPE_NAMES[String(m)] ?? String(m)).join(', ');
const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });

interface Picked {
  file: File;
  url: string;
  error?: string;
}

@Component({
  selector: 'article.at-card[avatarOf]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="at-card__header" [cardTitle]="t('profile.avatar')"></header>
    <div class="at-card__body">
      <div style="${FORM_GRID}">
        <div style="${ROW}">
          <span class="at-avatar" [name]="avatarOf().fullName" [src]="avatarSrc()" [size]="'l'"></span>
          @if (avatarOf().avatarUrl) {
            <button
              class="at-button"
              [variant]="'ghost'"
              [icon]="'trash'"
              [busy]="busy() === 'delete'"
              (click)="remove()"
            >
              {{ t('profile.deleteAvatar') }}
            </button>
          }
        </div>
        <div
          class="at-field"
          [files]="items()"
          [fileId]="'avatar-file'"
          [label]="t('field.file')"
          [accept]="accept"
          [hint]="t('profile.avatarHint')"
          [error]="picked()?.error"
          [disabled]="busy() !== null"
          (chosen)="pick($event)"
          (removed)="picked.set(null)"
        ></div>
      </div>
    </div>
    @if (picked(); as p) {
      @if (!p.error) {
        <footer class="at-card__footer">
          <button
            class="at-button"
            [variant]="'primary'"
            [icon]="'upload'"
            [busy]="busy() === 'upload'"
            (click)="upload()"
          >
            {{ t('action.upload') }}
          </button>
        </footer>
      }
    }`,
})
export class AvatarCardComponent {
  protected readonly t = t;
  readonly avatarOf = input.required<Me>();
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly live = injectLive();
  private readonly alert = formAlert();
  private readonly injector = inject(Injector);
  protected readonly accept = AVATAR_TYPES.join(',');
  protected readonly picked = signal<Picked | null>(null);
  protected readonly busy = signal<'upload' | 'delete' | null>(null);
  protected readonly avatarSrc = computed(() => {
    const url = this.avatarOf().avatarUrl;
    return url ? withVariant(url, 96) : null;
  });
  protected readonly items = computed<FileItem[]>(() => {
    const p = this.picked();
    if (!p) return [];
    return [
      {
        key: 'avatar',
        name: p.file.name,
        sizeText: p.error ?? formatBytes(p.file.size, LOCALE),
        error: Boolean(p.error),
        previewUrl: p.error ? undefined : p.url,
        kind: p.error ? (TYPE_NAMES[p.file.type] ?? '') : undefined,
      },
    ];
  });

  constructor() {
    let shown: Picked | null = null;
    effect(() => {
      const p = this.picked();
      if (shown && shown !== p) URL.revokeObjectURL(shown.url);
      shown = p;
    });
    inject(DestroyRef).onDestroy(() => {
      if (shown) URL.revokeObjectURL(shown.url);
    });
  }

  protected pick(files: File[]): void {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!AVATAR_TYPES.includes(file.type))
      error = t('files.unsupported', { allowed: typesText(AVATAR_TYPES) });
    else if (file.size > AVATAR_MAX_BYTES) error = tooLargeText(AVATAR_MAX_BYTES);
    this.picked.set({ file, url: URL.createObjectURL(file), error });
  }

  protected async upload(): Promise<void> {
    const p = this.picked();
    if (!p || p.error) return;
    this.alert.clear();
    const opener = actionOrigin();
    const generation = this.session.generation;
    this.busy.set('upload');
    try {
      const body = new FormData();
      body.append('file', p.file);
      await call(this.session.api.PUT('/me/avatar', { body: body as never }));
    } catch (e) {
      this.busy.set(null);
      if (!this.live(generation)) return;
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.['maxBytes']) || AVATAR_MAX_BYTES);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE') {
        const allowed = e.params?.['allowed'];
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(allowed) ? allowed : AVATAR_TYPES),
        });
      } else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.['file']?.[0])
        error = t(e.errors['file'][0]);
      if (error) this.picked.update((x) => (x ? { ...x, error } : x));
      else this.alert.error(e);
      this.refocus(opener, generation);
      return;
    }
    this.busy.set(null);
    if (generation === this.session.generation)
      this.toasts.push({ tone: 'ok', text: t('profile.avatarSaved') });
    if (this.live(generation)) {
      this.picked.set(null);
      this.refocus(opener, generation);
    }
    await this.session.reloadMe(generation);
  }

  protected async remove(): Promise<void> {
    this.alert.clear();
    const opener = actionOrigin();
    const generation = this.session.generation;
    this.busy.set('delete');
    try {
      await call(this.session.api.DELETE('/me/avatar'));
    } catch (e) {
      this.busy.set(null);
      if (this.live(generation)) {
        this.alert.error(e);
        this.refocus(opener, generation);
      }
      return;
    }
    this.busy.set(null);
    const me = this.session.me();
    if (me) this.session.setMe({ ...me, avatarUrl: null }, generation);
    if (generation === this.session.generation)
      this.toasts.push({ tone: 'ok', text: t('profile.avatarDeleted') });
    if (this.live(generation)) {
      this.refocus(opener, generation);
    }
    await this.session.reloadMe(generation);
  }

  private refocus(opener: ActionOrigin, generation: number): void {
    if (this.live(generation)) afterNextRender(() => restoreFocus(opener), { injector: this.injector });
  }
}

const POLL_MS = 5000;

@Component({
  selector: 'article.at-card[channels]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="at-card__header" [cardTitle]="t('profile.channels')"></header>
    <div class="at-card__body">
      @if (data(); as d) {
        <div style="${FORM_GRID}">
          <button
            class="at-switch"
            [checked]="d.email"
            [disabled]="saving()"
            (toggled)="save({ email: $event, telegram: d.telegram })"
          >
            {{ t('field.email') }}
          </button>
          <button
            class="at-switch"
            [checked]="d.telegram"
            [disabled]="saving() || (!d.telegramLinked && !d.telegram)"
            (toggled)="save({ email: d.email, telegram: $event })"
          >
            {{ t('field.telegram') }}
          </button>
          @if (code(); as c) {
            <div style="${FORM_GRID}">
              <p>{{ t('profile.telegramCode', { bot: c.botUsername, code: c.code }) }}</p>
              <p>{{ t('profile.telegramUntil', { time: until(c) }) }}</p>
              <div style="${ROW}">
                <a
                  class="at-button"
                  [variant]="'primary'"
                  [attr.href]="'https://t.me/' + c.botUsername + '?start=' + c.code"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ t('profile.openTelegram') }}</a
                >
                <button class="at-button" [variant]="'ghost'" [busy]="codeBusy()" (click)="newCode()">
                  {{ t('profile.newCode') }}
                </button>
              </div>
            </div>
          } @else if (!d.telegramLinked) {
            <div>
              <button class="at-button" [busy]="codeBusy()" (click)="newCode()">
                {{ t('profile.linkTelegram') }}
              </button>
            </div>
          }
        </div>
      } @else if (failed()) {
        <div style="${FORM_GRID}">
          <p>{{ t('profile.channelsFailed') }}</p>
          <div>
            <button class="at-button" [busy]="loading()" (click)="load()">{{ t('action.retry') }}</button>
          </div>
        </div>
      } @else {
        <div aria-busy="true" style="${FORM_GRID}">
          <span class="at-skeleton" [width]="'60%'"></span>
          <span class="at-skeleton" [width]="'40%'"></span>
        </div>
      }
    </div>`,
})
export class ChannelsCardComponent {
  protected readonly t = t;
  readonly channels = input(true);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly live = injectLive();
  private readonly alert = formAlert();
  private readonly injector = inject(Injector);
  private readonly channelsQuery = injectQuery(
    () => ({
      key: 'me/channels',
      load: () => call<NotificationChannels>(this.session.api.GET('/me/channels')),
    }),
    { failedText: t('profile.channelsFailed') },
  );
  protected readonly data = this.channelsQuery.data;
  protected readonly failed = this.channelsQuery.failed;
  protected readonly loading = this.channelsQuery.fetching;
  protected readonly saving = signal(false);
  protected readonly codeBusy = signal(false);
  protected readonly code = signal<TelegramCode | null>(null);

  constructor() {
    effect((onCleanup) => {
      const code = this.code();
      if (!code) return;
      const poll = setInterval(() => void this.load(), POLL_MS);
      const expire = setTimeout(
        () => this.code.set(null),
        Math.min(2 ** 31 - 1, Math.max(0, Date.parse(code.expiresAt) - Date.now())),
      );
      onCleanup(() => {
        clearInterval(poll);
        clearTimeout(expire);
      });
    });
    effect(() => {
      if (this.code() && this.data()?.telegramLinked) {
        untracked(() => {
          this.code.set(null);
          this.toasts.push({ tone: 'ok', text: t('profile.telegramLinked') });
        });
      }
    });
  }

  protected until(code: TelegramCode): string {
    return formatLocalTime(code.expiresAt, LOCALE);
  }

  load(): Promise<void> {
    return this.channelsQuery.refetch();
  }

  protected async save(next: { email: boolean; telegram: boolean }): Promise<void> {
    this.alert.clear();
    const generation = this.session.generation;
    const write = this.channelsQuery.writer();
    this.saving.set(true);
    try {
      write(await call<NotificationChannels>(this.session.api.PUT('/me/channels', { body: next })));
    } catch (e) {
      if (!this.live(generation)) return;
      const key =
        e instanceof ApiProblem ? (e.errors?.['telegram']?.[0] ?? e.errors?.['email']?.[0]) : undefined;
      this.alert.error(e, key ? t(key) : undefined);
    } finally {
      this.saving.set(false);
    }
  }

  protected async newCode(): Promise<void> {
    this.alert.clear();
    const opener = actionOrigin();
    const generation = this.session.generation;
    this.codeBusy.set(true);
    try {
      const code = await call<TelegramCode>(this.session.api.POST('/me/telegram-code'));
      if (this.live(generation)) this.code.set(code);
    } catch (e) {
      if (this.live(generation)) this.alert.error(e);
    } finally {
      this.codeBusy.set(false);
      if (this.live(generation)) afterNextRender(() => restoreFocus(opener), { injector: this.injector });
    }
  }
}

const groupSecret = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

@Component({
  selector: 'article.at-card[twoFactor]',
  standalone: true,
  imports: [...IMPORTS, QrComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="at-card__header" [cardTitle]="t('profile.twoFactor')">
      <span class="at-chip" [tone]="twoFactor().totpEnabled ? 'ok' : 'neutral'">{{
        t(twoFactor().totpEnabled ? 'profile.twoFactorOn' : 'profile.twoFactorOff')
      }}</span>
    </header>
    @if (!twoFactor().totpEnabled) {
      @if (pending(); as p) {
        <form novalidate (submit)="f.submit($event, confirm)">
          <div class="at-card__body">
            <div style="${FORM_GRID}">
              <span [qr]="p.otpauthUrl" [label]="t('profile.qr')"></span>
              <dl class="at-card__facts">
                <div>
                  <dt>{{ t('profile.secret') }}</dt>
                  <dd>
                    <span class="at-mono">{{ secret(p.secret) }}</span>
                  </dd>
                </div>
              </dl>
              <div
                class="at-field"
                [fieldId]="'totp-code'"
                [label]="t('auth.totpCode')"
                [error]="f.errorOf('code')"
              >
                <input
                  class="at-input at-mono"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="6"
                  name="code"
                  [formControl]="f.control('code')"
                />
              </div>
            </div>
          </div>
          <footer class="at-card__footer">
            ${submitButton('f', "t('profile.enable')")}
            <button class="at-button" [variant]="'ghost'" (click)="cancel()">
              {{ t('action.cancel') }}
            </button>
          </footer>
        </form>
      } @else {
        <footer class="at-card__footer">
          <button
            class="at-button"
            [busy]="starting()"
            [disabled]="startWait.left() > 0"
            [focusAfterWait]="startWait.left()"
            (click)="start()"
          >
            {{ startWait.left() > 0 ? t('auth.retryIn', { seconds: startWait.left() }) : t('profile.setup') }}
          </button>
        </footer>
      }
    }`,
})
export class TwoFactorCardComponent {
  protected readonly t = t;
  readonly twoFactor = input.required<Me>();
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly live = injectLive();
  protected readonly pending = signal<{ secret: string; otpauthUrl: string } | null>(null);
  protected readonly starting = signal(false);
  protected readonly f = new SchemaForm<{ code: string }, TwoFactorSetupRequest>(
    TwoFactorSetupRequestSchema,
    { code: '' },
    ['code'],
  );
  protected readonly startWait = countdown();
  protected readonly secret = groupSecret;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  private refocus(opener: ActionOrigin, generation: number, revealed?: () => HTMLElement | null): void {
    if (this.live(generation))
      afterNextRender(() => restoreFocus(opener, revealed?.()), { injector: this.injector });
  }

  protected cancel(): void {
    const opener = actionOrigin();
    this.pending.set(null);
    this.refocus(opener, this.session.generation, () =>
      this.host.querySelector<HTMLElement>('.at-card__footer > button.at-button'),
    );
  }

  private alreadyOn(generation: number): Promise<boolean> {
    if (this.live(generation)) this.pending.set(null);
    return this.session.reloadMe(generation);
  }

  protected async start(): Promise<void> {
    this.f.alert.clear();
    const opener = actionOrigin();
    const generation = this.session.generation;
    this.starting.set(true);
    let res: TwoFactorSetupResponse;
    try {
      res = await call<TwoFactorSetupResponse>(this.session.api.POST('/auth/2fa/setup', { body: {} }));
    } catch (e) {
      this.starting.set(false);
      if (e instanceof ApiProblem && e.status === 409) void this.alreadyOn(generation);
      else if (this.live(generation)) {
        if (e instanceof ApiProblem && e.status === 429) this.startWait.start(retryAfterOf(e));
        this.f.alert.error(e);
      }
      this.refocus(opener, generation);
      return;
    }
    this.starting.set(false);
    if (!('secret' in res && res.secret && res.otpauthUrl)) {
      void this.alreadyOn(generation);
      return;
    }
    if (!this.live(generation)) return;
    this.f.reset({ code: '' });
    this.pending.set({ secret: res.secret, otpauthUrl: res.otpauthUrl });
    this.refocus(opener, generation, () => document.getElementById('totp-code'));
  }

  protected readonly confirm = async (body: TwoFactorSetupRequest): Promise<void> => {
    const opener = actionOrigin();
    const generation = this.session.generation;
    try {
      await call<TwoFactorSetupResponse>(this.session.api.POST('/auth/2fa/setup', { body }));
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 409) void this.alreadyOn(generation);
      else if (!this.live(generation)) return;
      else if (e instanceof ApiProblem && e.code === 'INVALID_TWO_FACTOR_CODE')
        this.f.setError('code', 'errors.INVALID_TWO_FACTOR_CODE');
      else this.f.fail(e);
      this.refocus(opener, generation);
      return;
    }
    const me = this.session.me();
    if (me) this.session.setMe({ ...me, totpEnabled: true }, generation);
    if (generation === this.session.generation)
      this.toasts.push({ tone: 'ok', text: t('profile.twoFactorEnabled') });
    if (this.live(generation)) {
      this.pending.set(null);
      this.f.reset({ code: '' });
      this.refocus(opener, generation);
    }
    await this.session.reloadMe(generation);
  };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    ButtonComponent,
    CardHeaderComponent,
    ThemeSwitchComponent,
    PersonalCardComponent,
    AvatarCardComponent,
    ChannelsCardComponent,
    TwoFactorCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.profile')">
      <div class="at-page__actions">
        <button class="at-button" [icon]="'logout'" (click)="signOut()">{{ t('action.logout') }}</button>
      </div>
    </div>
    @if (me(); as user) {
      <div style="${GRID}">
        <article class="at-card" [personal]="user"></article>
        <article class="at-card" [avatarOf]="user"></article>
        <article class="at-card" [channels]="true"></article>
        @if (twoFactorOffered()) {
          <article class="at-card" [twoFactor]="user"></article>
        }
        <article class="at-card">
          <header class="at-card__header" [cardTitle]="t('profile.appearance')"></header>
          <div class="at-card__body"><fieldset class="at-field" [themeSwitch]="true"></fieldset></div>
        </article>
      </div>
    }`,
})
export class ProfilePage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  protected readonly me = this.session.me;
  protected readonly twoFactorOffered = computed(() => {
    const roles = this.me()?.roles ?? [];
    return roles.includes('INSPECTOR') || roles.includes('ADMIN');
  });

  protected signOut(): void {
    void this.session.signOut();
  }
}
