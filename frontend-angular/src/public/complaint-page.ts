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
  runInInjectionContext,
  signal,
  untracked,
  viewChild,
  type OnInit,
  type Signal,
} from '@angular/core';
import { ApiProblem, retryAfterOf } from '@agrotrace/api-client/public';
import { ArtDirective } from './art';
import { expiresAt, solveChallenge } from './altcha';
import { api, failureOf, injectBatch, type BatchState } from './data';
import { t } from './i18n';
import { batchPath, onLink } from './nav';
import { ART, arrivalFocus, HEADER, NOT_FOUND, titleEffect } from './views';
import { countdown, focusAfterWait } from './wait';

const TEXT_MIN = 10;
const EXPIRY_MARGIN_MS = 30_000;

type Errors = { text?: string; contact?: string };

const problemText = (code: string) => {
  const key = `errors.${code}`;
  return t(key) === key ? t('errors.UNKNOWN') : t(key);
};

export function checkComplaint(text: string, contact: string): Errors {
  const errors: Errors = {};
  if (!/\S/.test(text)) errors.text = t('validation.required');
  else if ([...text].length < TEXT_MIN) errors.text = t('public.textShort');
  if (contact !== '' && !/\S/.test(contact)) errors.contact = t('validation.pattern');
  return errors;
}

interface Solved {
  payload: string;
  expires: number | null;
}

function altcha() {
  let pending: Promise<Solved> | null = null;
  const prepare = () => {
    const p = api
      .getCaptcha()
      .then(async (c) => ({ payload: await solveChallenge(c), expires: expiresAt(c) }));
    p.catch(() => undefined);
    pending = p;
    return p;
  };
  const take = async () => {
    const ready = await (pending ?? prepare()).catch(() => null);
    const fresh =
      ready && (ready.expires === null || ready.expires - Date.now() > EXPIRY_MARGIN_MS)
        ? ready
        : await prepare();
    pending = null;
    return fresh.payload;
  };
  return { take, prepare };
}

type Message = { text: string; tone: 'danger' | 'attention' };

function field(id: string, label: string, error: string, control: string): string {
  return `<div class="at-field" [attr.data-invalid]="${error} ? '' : null">
              <label class="at-field__label" for="${id}">{{ t('${label}') }}</label>
              ${control}
              @if (${error}) {
                <p class="at-field__error" id="${id}-error" role="alert">{{ ${error} }}</p>
              }
            </div>`;
}

function invalid(error: string, id: string): string {
  return `[attr.aria-invalid]="${error} ? 'true' : null" [attr.aria-describedby]="${error} ? '${id}-error' : null"`;
}

function back(variant: string): string {
  return `<a class="at-button" data-variant="${variant}" [attr.href]="batchPath(atComplaint())" (click)="onLink($event)">{{
            t('public.toBatch')
          }}</a>`;
}

@Component({
  selector: 'main[complaintPage]',
  standalone: true,
  imports: [ArtDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'at-page at-public', id: 'main', tabindex: '-1' },
  template: `${HEADER}
    <div class="at-public__stack">
      @if (state().status === 'notFound' || gone()) {
        ${NOT_FOUND}
      } @else if (done()) {
        <article class="at-card" data-furrow="">
          <div class="at-card__body at-public__done">
            <p #doneText class="at-public__done-text" tabindex="-1">{{ t('public.sent') }}</p>
            ${back('primary')}
          </div>
        </article>
      } @else {
        <article class="at-card" data-furrow="">
          <div class="at-card__body">
            @if (batch(); as b) {
              <!-- prettier-ignore -->
              <p class="at-public__about">{{ b.product.name }} <span class="at-mono">{{ b.publicCode }}</span></p>
            }
            <form id="complaint" class="at-public__form" novalidate (submit)="submit($event)">
              ${field(
                'complaint-text',
                'public.text',
                'errors().text',
                `<textarea
                #textArea
                id="complaint-text"
                class="at-textarea"
                rows="6"
                maxlength="2000"
                ${invalid('errors().text', 'complaint-text')}
                [value]="text()"
                (input)="text.set($any($event.target).value)"
              ></textarea>`,
              )}
              ${field(
                'complaint-contact',
                'public.contact',
                'errors().contact',
                `<input
                #contactInput
                id="complaint-contact"
                class="at-input"
                autocomplete="on"
                maxlength="255"
                ${invalid('errors().contact', 'complaint-contact')}
                [value]="contact()"
                [attr.value]="contact()"
                (input)="contact.set($any($event.target).value)"
              />`,
              )}
              @if (message(); as m) {
                <!-- prettier-ignore -->
                <p [class]="m.tone === 'danger' ? 'at-field__error' : 'at-field__warning'" role="alert">{{ m.text }}</p>
              }
            </form>
          </div>
          <footer class="at-card__footer">
            ${back('secondary')}
            <!-- prettier-ignore -->
            <button #submitButton class="at-button" type="submit" form="complaint" data-variant="primary" [attr.aria-busy]="busy() ? 'true' : null" [disabled]="wait.left() > 0" (click)="busy() ? $event.preventDefault() : null">{{ wait.left() > 0 ? t('auth.retryIn', { seconds: wait.left() }) : t('public.send') }}</button>
          </footer>
        </article>
      }
    </div>`,
})
export class ComplaintPageComponent implements OnInit {
  protected readonly t = t;
  protected readonly art = ART;
  protected readonly batchPath = batchPath;
  protected readonly onLink = onLink;
  readonly atComplaint = input.required<string>({ alias: 'complaintPage' });
  private readonly injector = inject(Injector);
  private readonly loaded = signal<Signal<BatchState> | null>(null);
  protected readonly state = computed<BatchState>(() => this.loaded()?.() ?? { status: 'loading' });
  protected readonly batch = computed(() => {
    const s = this.state();
    return s.status === 'ok' ? s.batch : null;
  });
  protected readonly title = signal(t('page.publicComplaint'));
  private readonly altcha = altcha();
  protected readonly text = signal('');
  protected readonly contact = signal('');
  protected readonly errors = signal<Errors>({});
  protected readonly message = signal<Message | null>(null);
  protected readonly busy = signal(false);
  protected readonly gone = signal(false);
  protected readonly done = signal(false);
  protected readonly wait = countdown();
  private readonly textArea = viewChild<ElementRef<HTMLTextAreaElement>>('textArea');
  private readonly contactInput = viewChild<ElementRef<HTMLInputElement>>('contactInput');
  private readonly submitButton = viewChild<ElementRef<HTMLElement>>('submitButton');
  private readonly doneText = viewChild<ElementRef<HTMLElement>>('doneText');
  private alive = true;

  constructor() {
    titleEffect(this.title);
    arrivalFocus();
    focusAfterWait(this.wait.left, () => this.submitButton());
    effect(() => {
      if (this.wait.left() === 0)
        untracked(() => this.message.update((m) => (m?.tone === 'attention' ? null : m)));
    });
    effect(() => {
      const el = this.doneText();
      if (el) untracked(() => el.nativeElement.focus());
    });
    inject(DestroyRef).onDestroy(() => (this.alive = false));
    this.altcha.prepare();
  }

  ngOnInit(): void {
    runInInjectionContext(this.injector, () => this.loaded.set(injectBatch(this.atComplaint()).state));
  }

  private showErrors(next: Errors): void {
    this.errors.set(next);
    const target = next.text ? this.textArea : next.contact ? this.contactInput : null;
    if (target) afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || this.wait.left() > 0) return;
    const text = this.text();
    const contact = this.contact();
    const found = checkComplaint(text, contact);
    this.message.set(null);
    if (found.text || found.contact) return this.showErrors(found);
    this.errors.set({});
    this.busy.set(true);
    let sent = false;
    const fail = (text: string) => this.message.set({ text, tone: 'danger' });
    try {
      let payload: string;
      try {
        payload = await this.altcha.take();
      } catch {
        fail(t('public.captchaUnavailable'));
        return;
      }
      sent = true;
      await api.createComplaint(this.atComplaint(), {
        text,
        ...(contact === '' ? {} : { contact }),
        altcha: payload,
      });
      if (this.alive) this.done.set(true);
    } catch (err) {
      if (!this.alive) return;
      if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [path, keys] of Object.entries(err.errors)) {
          const key = keys[0] ?? '';
          const text = t(key) === key ? t('errors.VALIDATION') : t(key);
          if (path === 'text' || path === 'contact') next[path] ??= text;
          else rest.push(text);
        }
        if (next.text || next.contact) this.showErrors(next);
        if (rest.length || !(next.text || next.contact)) fail(rest.join('. ') || problemText(err.code));
      } else if (err instanceof ApiProblem && err.code === 'CAPTCHA_FAILED') fail(t('public.captchaRetry'));
      else if (err instanceof ApiProblem && err.status === 429) {
        const seconds = retryAfterOf(err) ?? 60;
        this.wait.start(seconds);
        this.message.set({ text: t('auth.rateLimited', { seconds }), tone: 'attention' });
      } else if (err instanceof ApiProblem && err.status === 404) this.gone.set(true);
      else if (err instanceof ApiProblem) fail(problemText(err.code));
      else fail(t(failureOf(err).kind === 'offline' ? 'public.offline' : 'public.unavailable'));
    } finally {
      if (this.alive) {
        this.busy.set(false);
        if (sent) this.altcha.prepare();
      }
    }
  }
}
