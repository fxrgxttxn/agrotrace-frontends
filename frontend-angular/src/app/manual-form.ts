import { afterNextRender, computed, Injector, inject, signal, untracked, type Signal } from '@angular/core';
import { countdown } from './api';
import { injectAlive } from './alive';
import { applyProblem, formAlert } from './forms';
import { t } from './i18n';

export class ManualForm<V> {
  readonly values: ReturnType<typeof signal<V>>;
  readonly busy = signal(false);
  readonly wait: Signal<number>;
  readonly alert = formAlert();
  readonly submitted = signal(false);
  private readonly revealed = signal<((path: string) => boolean)[]>([]);
  private readonly server = signal<Record<string, string>>({});
  private readonly startWait: (seconds: number) => void;
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
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

  update(change: (v: V) => V, ...paths: string[]): void {
    this.values.update(change);
    if (paths.length === 0) return;
    const server = untracked(this.server);
    if (!paths.some((p) => p in server)) return;
    const rest = { ...server };
    for (const p of paths) delete rest[p];
    this.server.set(rest);
  }

  errorOf(path: string): string | null {
    const server = this.server()[path];
    if (server) return t(server);
    if (!this.submitted() && !this.revealed().some((p) => p(path))) return null;
    const key = this.errors()[path];
    return key ? t(key) : null;
  }

  setError(path: string, key: string): void {
    if (!this.alive()) return;
    this.server.update((s) => ({ ...s, [path]: key }));
  }

  valid(paths: (path: string) => boolean): boolean {
    this.revealed.update((r) => [...r, paths]);
    return !Object.keys(this.errors()).some(paths);
  }

  focusFirstInvalid(root: HTMLElement | null = this.formEl): void {
    if (!root) return;
    afterNextRender(() => root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), {
      injector: this.injector,
    });
  }

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

  rateLimited(seconds: number): void {
    this.startWait(seconds);
  }

  serverError(paths: (path: string) => boolean): boolean {
    return Object.keys(this.server()).some(paths);
  }
}
