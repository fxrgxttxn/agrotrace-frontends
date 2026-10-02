import { afterNextRender, computed, Injector, inject, signal, untracked, type Signal } from '@angular/core';
import { countdown } from './api';
import { injectAlive } from './alive';
import { applyProblem, formAlert } from './forms';
import { t } from './i18n';

// A form whose fields are not a fixed set (a row field per chosen batch, a list of outputs): the React app builds them
// with react-hook-form and a resolver of its own; here the values are a signal and `check` is that resolver — it
// returns the errors of the values (path → i18n key) or none. The behaviour is the one of every form (forms.ts):
// errors appear after the first submit and follow every change from then on; a server error of a field stays until
// that field changes; a failed submit focuses the first invalid field in form order; one form message at a time; a
// 429 disables the submit with a countdown. Create it in an injection context.

export class ManualForm<V> {
  readonly values: ReturnType<typeof signal<V>>;
  readonly busy = signal(false);
  readonly wait: Signal<number>;
  readonly alert = formAlert();
  readonly submitted = signal(false);
  /** Paths checked by a step of a wizard before the submit (their errors show from then on). */
  private readonly revealed = signal<((path: string) => boolean)[]>([]);
  private readonly server = signal<Record<string, string>>({});
  private readonly startWait: (seconds: number) => void;
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
  /** The client errors of the values as they are now (path → i18n key). */
  readonly errors = computed(() => this.check(this.values()));
  private formEl: HTMLElement | null = null;

  constructor(
    defaults: V,
    private readonly check: (values: V) => Record<string, string>,
  ) {
    this.values = signal(defaults);
    const cd = countdown();
    this.wait = cd.left;
    this.startWait = cd.start;
  }

  /** Changes the values; the server errors of `paths` go (the person changed those fields). */
  update(change: (v: V) => V, ...paths: string[]): void {
    this.values.update(change);
    if (paths.length === 0) return;
    const server = untracked(this.server);
    if (!paths.some((p) => p in server)) return;
    const rest = { ...server };
    for (const p of paths) delete rest[p];
    this.server.set(rest);
  }

  /** Translated error of a field (`null` — none). */
  errorOf(path: string): string | null {
    const server = this.server()[path];
    if (server) return t(server);
    if (!this.submitted() && !this.revealed().some((p) => p(path))) return null;
    const key = this.errors()[path];
    return key ? t(key) : null;
  }

  /** Puts an error (i18n key) under a field, as a server's. */
  setError(path: string, key: string): void {
    if (!this.alive()) return;
    this.server.update((s) => ({ ...s, [path]: key }));
  }

  /** Whether `paths` are free of errors now (a step of a wizard checked by «Далее»: their errors show from now on). */
  valid(paths: (path: string) => boolean): boolean {
    this.revealed.update((r) => [...r, paths]);
    return !Object.keys(this.errors()).some(paths);
  }

  /** Focuses the first invalid control of the form once the view shows the errors. */
  focusFirstInvalid(): void {
    const root = this.formEl;
    if (!root) return;
    afterNextRender(() => root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), {
      injector: this.injector,
    });
  }

  /** The submit handler: checks the values, then runs `action` (busy meanwhile). `invalid` — what to do when the check
   * fails (a wizard shows the step first); the first invalid field takes the focus. */
  async submit(
    e: Event,
    action: (values: V) => Promise<void>,
    invalid?: (errors: Record<string, string>) => void,
  ): Promise<void> {
    e.preventDefault();
    this.formEl = (e.target as HTMLElement | null) ?? this.formEl;
    if (this.busy() || this.wait() > 0) return;
    this.submitted.set(true);
    this.server.set({});
    const errors = this.check(this.values());
    if (Object.keys(errors).length) {
      invalid?.(errors);
      this.focusFirstInvalid();
      return;
    }
    this.alert.clear();
    this.busy.set(true);
    try {
      await action(this.values());
    } finally {
      this.busy.set(false);
    }
  }

  /** A failed submit: 400 `errors` under the fields it renders (`fields`, `alias` maps a server path), a 429 as the
   * countdown, anything else as the form message. */
  fail(
    e: unknown,
    fields: readonly string[],
    alias?: (path: string) => string,
    alert = this.alert.show,
  ): void {
    if (!this.alive()) return;
    applyProblem(e, {
      alert,
      onRateLimit: this.startWait,
      fields,
      alias,
      mark: (marks) => {
        this.server.set(marks);
        this.focusFirstInvalid();
      },
    });
  }

  /** Starts a 429 wait on the submit. */
  rateLimited(seconds: number): void {
    this.startWait(seconds);
  }

  /** Whether a server error is shown for any of `paths`. */
  serverError(paths: (path: string) => boolean): boolean {
    return Object.keys(this.server()).some(paths);
  }
}
