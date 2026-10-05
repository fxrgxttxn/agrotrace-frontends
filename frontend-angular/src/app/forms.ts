import {
  afterNextRender,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { AbstractControl, FormControl, FormGroup, type ValidatorFn } from '@angular/forms';
import { ApiProblem } from '@agrotrace/api-client';
import { countdown, errorText, retryAfterOf } from './api';
import { injectAlive } from './alive';
import { focusIfFree } from './focus';
import { t } from './i18n';
import { ToastService } from './ui/toasts';

export interface SchemaLike {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

function issuesByPath(schema: SchemaLike, value: unknown): Record<string, string> | null {
  const res = schema.safeParse(value);
  if (res.success) return null;
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const path = issue.path.map(String).join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

export function zodValidator(schema: SchemaLike, toWire: (value: never) => unknown = (v) => v): ValidatorFn {
  return (control: AbstractControl) => {
    const issues = issuesByPath(schema, toWire(control.getRawValue() as never));
    return issues ? { schema: issues } : null;
  };
}

export function dropEmpty<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== '' && v !== undefined),
  ) as Partial<T>;
}

export function formAlert(): {
  show: (text: string, tone?: 'danger' | 'attention') => void;
  error: (e: unknown, text?: string) => void;
  clear: () => void;
} {
  const toasts = inject(ToastService);
  let id: number | null = null;
  const clear = () => {
    if (id !== null) toasts.dismiss(id);
    id = null;
  };
  let alive = true;
  inject(DestroyRef).onDestroy(() => {
    alive = false;
    clear();
  });
  const show = (text: string, tone: 'danger' | 'attention' = 'danger') => {
    if (!alive) return;
    clear();
    id = toasts.push({ tone, text });
  };
  return {
    show,
    error: (e, text) => {
      if (!quietFailure(e)) show(text ?? errorText(e), errorTone(e));
    },
    clear,
  };
}

export interface DialogAlert {
  readonly message: Signal<string | null>;
  show: (text: string, tone?: 'danger' | 'attention') => void;
  error: (e: unknown, text?: string) => void;
  clear: () => void;
  handOff: () => void;
}

export function dialogAlert(): DialogAlert {
  const toasts = inject(ToastService);
  const alive = injectAlive();
  const message = signal<string | null>(null);
  let current: { text: string; tone: 'danger' | 'attention' } | null = null;
  const show = (text: string, tone: 'danger' | 'attention' = 'danger') => {
    current = { text, tone };
    message.set(text);
  };
  const clear = () => {
    current = null;
    message.set(null);
  };
  return {
    message: message.asReadonly(),
    show,
    error: (e, text) => {
      if (!quietFailure(e)) show(text ?? errorText(e), errorTone(e));
    },
    clear,
    handOff: () => {
      const failure = current;
      clear();
      if (failure && alive()) toasts.push(failure);
    },
  };
}

export function quietFailure(e: unknown): boolean {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'CancelledError')) return true;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError')
    return true;
  return (
    e instanceof ApiProblem && e.status === 401 && (e.code === 'UNAUTHORIZED' || e.code === 'TOKEN_EXPIRED')
  );
}

export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}

export function focusFirstInvalid(root: HTMLElement | null, injector: Injector): void {
  if (!root) return;
  afterNextRender(() => root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), { injector });
}

type Controls<V> = { [K in keyof V]: V[K] extends Record<string, unknown> ? FormGroup : FormControl };

function build(values: Record<string, unknown>): FormGroup {
  const controls: Record<string, AbstractControl> = {};
  for (const [k, v] of Object.entries(values))
    controls[k] =
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? build(v as Record<string, unknown>)
        : new FormControl(v, { nonNullable: true });
  return new FormGroup(controls);
}

export interface SchemaFormOptions<V> {
  toWire?: (values: V) => unknown;
  alias?: (path: string) => string;
  dialog?: boolean;
}

export class SchemaForm<V extends Record<string, unknown>, B = V> {
  readonly group: FormGroup<Controls<V>>;
  readonly busy = signal(false);
  readonly wait: Signal<number>;
  private readonly toastAlert = formAlert();
  private readonly dialogAlert = dialogAlert();
  private inDialog: boolean;
  readonly message: Signal<string | null> = this.dialogAlert.message;
  readonly alert = {
    show: (text: string, tone?: 'danger' | 'attention') => {
      if (this.inDialog) this.dialogAlert.show(text, tone);
      else this.toastAlert.show(text, tone);
    },
    error: (e: unknown, text?: string) => {
      if (!quietFailure(e)) this.alert.show(text ?? errorText(e), errorTone(e));
    },
    clear: () => {
      this.dialogAlert.clear();
      this.toastAlert.clear();
    },
  };
  readonly handOff = (): void => this.dialogAlert.handOff();
  useDialog(on: boolean): void {
    this.inDialog = on;
  }

  private readonly submitted = signal(false);
  private readonly server = signal<Record<string, string>>({});
  private readonly version = signal(0);
  private readonly startWait: (seconds: number) => void;
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
  private readonly toWire: (values: V) => unknown;
  private readonly alias: ((path: string) => string) | undefined;
  private formEl: HTMLElement | null = null;

  constructor(
    private readonly schema: SchemaLike,
    defaults: V,
    readonly fields: readonly string[],
    options: SchemaFormOptions<V> = {},
  ) {
    this.toWire = options.toWire ?? ((v) => v);
    this.alias = options.alias;
    this.inDialog = options.dialog ?? false;
    this.group = build(defaults) as FormGroup<Controls<V>>;
    this.group.addValidators(zodValidator(schema, this.toWire as (v: never) => unknown));
    this.group.updateValueAndValidity();
    const cd = countdown();
    this.wait = cd.left;
    this.startWait = cd.start;
    const subs = [this.group.statusChanges.subscribe(() => this.version.update((n) => n + 1))];
    for (const path of fields) {
      const control = this.group.get(path);
      if (control)
        subs.push(
          control.valueChanges.subscribe(() => {
            if (path in untracked(this.server)) {
              const rest = { ...untracked(this.server) };
              delete rest[path];
              this.server.set(rest);
            }
          }),
        );
    }
    inject(DestroyRef).onDestroy(() => subs.forEach((s) => s.unsubscribe()));
  }

  control(path: string): FormControl {
    const c = this.group.get(path);
    if (!(c instanceof FormControl)) throw new Error(`No form control ${path}`);
    return c;
  }

  valueOf<T = unknown>(path: string): T {
    this.version();
    return this.control(path).value as T;
  }

  errorOf(path: string): string | null {
    this.version();
    const server = this.server()[path];
    if (server) return t(server);
    if (!this.submitted()) return null;
    const key = (this.group.errors?.['schema'] as Record<string, string> | undefined)?.[path];
    return key ? t(key) : null;
  }

  setError(path: string, message: string): void {
    if (!this.alive()) return;
    this.server.update((s) => ({ ...s, [path]: message }));
    focusFirstInvalid(this.formEl, this.injector);
  }

  fieldError(path: string, message: string | null): void {
    if (message === null) this.clearError(path);
    else this.server.update((s) => ({ ...s, [path]: message }));
  }

  rateLimited(seconds: number): void {
    this.startWait(seconds);
  }

  clearError(path: string): void {
    if (!(path in untracked(this.server))) return;
    const rest = { ...untracked(this.server) };
    delete rest[path];
    this.server.set(rest);
  }

  reset(values: V): void {
    this.group.reset(values as never);
    this.submitted.set(false);
    this.server.set({});
  }

  async submit(e: Event, action: (body: B) => Promise<void>): Promise<void> {
    e.preventDefault();
    this.formEl = (e.target as HTMLElement | null) ?? this.formEl;
    if (this.busy() || this.wait() > 0) return;
    this.submitted.set(true);
    this.server.set({});
    this.version.update((n) => n + 1);
    const res = this.schema.safeParse(this.toWire(this.group.getRawValue() as V));
    if (!res.success) {
      focusFirstInvalid(this.formEl, this.injector);
      return;
    }
    this.alert.clear();
    this.busy.set(true);
    try {
      await action(res.data as B);
    } finally {
      this.busy.set(false);
    }
  }

  fail(e: unknown): void {
    if (!this.alive()) return;
    applyProblem(e, {
      alert: this.alert.show,
      onRateLimit: this.startWait,
      fields: this.fields,
      alias: this.alias,
      mark: (marks) => {
        this.server.set(marks);
        focusFirstInvalid(this.formEl, this.injector);
      },
    });
  }
}

export interface ApplyOptions {
  alert: (text: string, tone?: 'danger' | 'attention') => void;
  onRateLimit?: (seconds: number) => void;
  fields?: readonly string[];
  mark?: (errors: Record<string, string>) => void;
  alias?: ((path: string) => string) | undefined;
}

export function applyProblem(e: unknown, o: ApplyOptions): void {
  if (quietFailure(e)) return;
  if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
    const rest: string[] = [];
    const fields = o.fields ?? [];
    const marks: Record<string, string> = {};
    for (const [raw, keys] of Object.entries(e.errors)) {
      const path = o.alias ? o.alias(raw) : raw;
      const key = keys[0];
      if (!key) continue;
      if (o.mark && fields.includes(path)) marks[path] ??= key;
      else rest.push(t(key));
    }
    const marked = Object.keys(marks).length > 0;
    if (marked) o.mark?.(marks);
    if (rest.length) o.alert(rest.join('. '));
    else if (!marked) o.alert(errorText(e));
    return;
  }
  if (e instanceof ApiProblem && e.status === 429) {
    const seconds = retryAfterOf(e);
    o.onRateLimit?.(seconds);
    o.alert(t('auth.rateLimited', { seconds }), 'attention');
    return;
  }
  o.alert(errorText(e));
}

@Directive({ selector: 'button[focusAfterWait]', standalone: true })
export class FocusAfterWaitDirective {
  readonly focusAfterWait = input.required<number>();

  constructor() {
    const el = inject<ElementRef<HTMLButtonElement>>(ElementRef).nativeElement;
    const injector = inject(Injector);
    let waiting = false;
    effect(() => {
      if (this.focusAfterWait() > 0) waiting = true;
      else if (waiting) {
        waiting = false;
        afterNextRender(() => focusIfFree(el), { injector });
      }
    });
  }
}

export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

export function wireSchema<V>(
  shared: SchemaLike,
  toWire: (values: V) => unknown,
  precheck?: (values: V) => Record<string, string>,
): SchemaLike {
  return {
    safeParse(values: unknown) {
      const early = Object.entries(precheck?.(values as V) ?? {});
      const issues: { path: PropertyKey[]; message: string }[] = early.map(([path, message]) => ({
        path: [path],
        message,
      }));
      const marked = new Set(early.map(([path]) => path));
      const body = dropEmpty(toWire(values as V) as Record<string, unknown>);
      const res = shared.safeParse(body);
      if (res.success && early.length === 0) return { success: true as const, data: res.data };
      for (const issue of res.success ? [] : res.error.issues) {
        const path = issue.path.slice(0, 1);
        if (marked.has(String(path[0]))) continue;
        issues.push({ path, message: issue.message });
      }
      return { success: false as const, error: { issues } };
    },
  };
}
