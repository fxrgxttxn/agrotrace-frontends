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

// Forms (spec §9.2): Reactive Forms on the shared Zod schemas of @agrotrace/validation through a Zod → ValidatorFn
// adapter — the same messages (i18n keys) as the React app's zodResolver. Behaviour of the React forms (reference):
// errors appear after the first submit and follow every change from then on; a server error of a field stays until
// that field changes; a failed submit focuses the first invalid field in form order; form-level messages are one
// toast per form (danger, or attention for a 429 — ruling F7), replaced on the next submit; a 429 disables the submit
// with a countdown and gives it the focus back when the wait is over. Nothing is trimmed (R36).

/** What the adapter needs of a Zod schema (structural: the app does not depend on `zod` itself). */
export interface SchemaLike {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/** Issues of a failed parse by dotted path (`admin.email`), the first message (an i18n key) of each path. */
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

/** The Zod → ValidatorFn adapter: validates the control's (group's) raw value, mapped by `toWire` to the request body,
 * against the shared schema. Errors: `{ schema: { 'admin.email': 'validation.email', … } }` (i18n keys). */
export function zodValidator(schema: SchemaLike, toWire: (value: never) => unknown = (v) => v): ValidatorFn {
  return (control: AbstractControl) => {
    const issues = issuesByPath(schema, toWire(control.getRawValue() as never));
    return issues ? { schema: issues } : null;
  };
}

/** A body built from the form values; `''` / `undefined` members are absent (an optional field left empty). */
export function dropEmpty<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== '' && v !== undefined),
  ) as Partial<T>;
}

/** One form-level message at a time (a toast): a new message or submit replaces it; it goes when the form goes. Must
 * be created in an injection context. */
export function formAlert(): {
  show: (text: string, tone?: 'danger' | 'attention') => void;
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
  return {
    // FM25: a message of a screen that is gone is not shown (it would stay, unowned)
    show: (text, tone = 'danger') => {
      if (!alive) return;
      clear();
      id = toasts.push({ tone, text });
    },
    clear,
  };
}

/** A rate limit is a wait, not a failure: attention tone; everything else is an error. */
export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}

/** Focuses the first invalid control of `root` (form order) once the view shows the errors. */
function focusFirstInvalid(root: HTMLElement | null, injector: Injector): void {
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
  /** The request body of the values (default: the values as they are). */
  toWire?: (values: V) => unknown;
}

/** A form on a shared schema: the Reactive Forms group (validated by {@link zodValidator}), the error texts the
 * template shows, the form message, the 429 countdown and the submit flow. Create it in an injection context. */
export class SchemaForm<V extends Record<string, unknown>, B = V> {
  readonly group: FormGroup<Controls<V>>;
  /** Sending (the submit button is `aria-busy`). */
  readonly busy = signal(false);
  /** Seconds left of a 429 wait (0 — free). */
  readonly wait: Signal<number>;
  readonly alert = formAlert();

  private readonly submitted = signal(false);
  private readonly server = signal<Record<string, string>>({});
  /** Bumped on every value / status change: the error texts are read from the group in templates (OnPush). */
  private readonly version = signal(0);
  private readonly startWait: (seconds: number) => void;
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
  private readonly toWire: (values: V) => unknown;
  private formEl: HTMLElement | null = null;

  constructor(
    private readonly schema: SchemaLike,
    defaults: V,
    /** Paths the form renders, in form order (server errors on other paths are the form message). */
    readonly fields: readonly string[],
    options: SchemaFormOptions<V> = {},
  ) {
    this.toWire = options.toWire ?? ((v) => v);
    this.group = build(defaults) as FormGroup<Controls<V>>;
    this.group.addValidators(zodValidator(schema, this.toWire as (v: never) => unknown));
    this.group.updateValueAndValidity();
    const cd = countdown();
    this.wait = cd.left;
    this.startWait = cd.start;
    const subs = [this.group.statusChanges.subscribe(() => this.version.update((n) => n + 1))];
    // A server error of a field stays until that field changes.
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

  /** The control at `path` (`admin.email`). */
  control(path: string): FormControl {
    const c = this.group.get(path);
    if (!(c instanceof FormControl)) throw new Error(`No form control ${path}`);
    return c;
  }

  /** Translated error text of a field (`null` — none). */
  errorOf(path: string): string | null {
    this.version();
    const server = this.server()[path];
    if (server) return t(server);
    if (!this.submitted()) return null;
    const key = (this.group.errors?.['schema'] as Record<string, string> | undefined)?.[path];
    return key ? t(key) : null;
  }

  /** Puts an error (i18n key or ready text) under a field and focuses it. */
  setError(path: string, message: string): void {
    if (!this.alive()) return;
    this.server.update((s) => ({ ...s, [path]: message }));
    focusFirstInvalid(this.formEl, this.injector);
  }

  /** Back to `values` (after a successful save): no errors shown until the next submit. */
  reset(values: V): void {
    this.group.reset(values as never);
    this.submitted.set(false);
    this.server.set({});
  }

  /** The submit handler: checks the shared schema, then runs `action` with the body (busy meanwhile). */
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

  /** A failed submit on the form: 400 `errors` under the fields it renders (the rest as the form message), a 429 as
   * the countdown on the submit, anything else as the form message. */
  fail(e: unknown): void {
    if (!this.alive()) return; // FM25: the screen is gone — nothing to show the failure on
    applyProblem(e, {
      alert: this.alert.show,
      onRateLimit: this.startWait,
      fields: this.fields,
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
  /** Field paths the form renders; absent — an action without a form (every error is the message). */
  fields?: readonly string[];
  /** Shows server errors under fields (path → i18n key). */
  mark?: (errors: Record<string, string>) => void;
}

/** Puts a failed request on a form or an action: field errors, a form-level message, or the rate-limit countdown. */
export function applyProblem(e: unknown, o: ApplyOptions): void {
  if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
    const rest: string[] = [];
    const fields = o.fields ?? [];
    const marks: Record<string, string> = {};
    for (const [path, keys] of Object.entries(e.errors)) {
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

/** The action button a 429 wait disabled: it gets the focus back when it can act again (FM17: only when the focus is
 * free) — as the «Повторить» of the unavailable screen (F8). */
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
