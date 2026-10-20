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
  /** The message of a failed request (its text, or `text`), unless it is one nobody should be told of (FM29). */
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
    // FM25: a message of a screen that is gone is not shown (it would stay, unowned)
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

/** The message of a failure inside a modal dialog (README «Диалог», polish P1 — the React app's `useDialogAlert`). */
export interface DialogAlert {
  /** The failure said in the dialog (`role="alert"` in its body), null — none. */
  readonly message: Signal<string | null>;
  show: (text: string, tone?: 'danger' | 'attention') => void;
  /** The message of a failed request, unless it is one nobody should be told of (FM29). */
  error: (e: unknown, text?: string) => void;
  /** A new attempt or a success: the failure no longer applies. */
  clear: () => void;
  /** The dialog closes (Отмена, the cross, Esc, or the screen closes it): a failure that still applies goes to the
   * page as a toast. */
  handOff: () => void;
}

/** README «Диалог» (polish P1): a failure inside an open modal dialog is said once — in the dialog's `role="alert"`,
 * never at the same time as a page toast (the toast region is behind the modal, and both would be announced). When
 * the dialog closes while the failure still applies (no retry or success cleared it), the page gets it as a toast.
 * Must be created in an injection context. */
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
      // FM26: a failure of a screen that is gone is not shown.
      if (failure && alive()) toasts.push(failure);
    },
  };
}

/** FM29: failures nobody is told of — a cancelled request (AbortError / CancelledError), and a 401 of a signed-in
 * request that the auth flow handles itself (the session-lost message and the login). A 401 answer of the login /
 * 2FA screens (INVALID_CREDENTIALS, INVALID_TWO_FACTOR_CODE, …) is an answer and is shown. */
export function quietFailure(e: unknown): boolean {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'CancelledError')) return true;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError')
    return true;
  return (
    e instanceof ApiProblem && e.status === 401 && (e.code === 'UNAUTHORIZED' || e.code === 'TOKEN_EXPIRED')
  );
}

/** A rate limit is a wait, not a failure: attention tone; everything else is an error. */
export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}

/** Focuses the first invalid control of `root` (form order) once the view shows the errors. */
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
  /** The request body of the values (default: the values as they are). */
  toWire?: (values: V) => unknown;
  /** Server error paths onto form fields (`geometry.coordinates[0]` → `geometry`). */
  alias?: (path: string) => string;
  /** A form inside a modal dialog (README «Диалог»): the form-level message is said only in the dialog (`message`);
   * `handOff()` on close gives a message that still applies to the page as a toast. */
  dialog?: boolean;
}

/** A form on a shared schema: the Reactive Forms group (validated by {@link zodValidator}), the error texts the
 * template shows, the form message, the 429 countdown and the submit flow. Create it in an injection context. */
export class SchemaForm<V extends Record<string, unknown>, B = V> {
  readonly group: FormGroup<Controls<V>>;
  /** Sending (the submit button is `aria-busy`). */
  readonly busy = signal(false);
  /** Seconds left of a 429 wait (0 — free). */
  readonly wait: Signal<number>;
  private readonly toastAlert = formAlert();
  private readonly dialogAlert = dialogAlert();
  private inDialog: boolean;
  /** The form-level message of a form inside a modal dialog (`dialog: true`), said in its body only (README «Диалог»:
   * the page's toast region is behind the modal); null for a form on the page (its message is a toast). */
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
  /** The dialog of the form closes: a form message that still applies goes to the page as a toast. */
  readonly handOff = (): void => this.dialogAlert.handOff();
  /** A form whose place (a dialog or the page) is known only once its inputs are set. */
  useDialog(on: boolean): void {
    this.inDialog = on;
  }

  private readonly submitted = signal(false);
  private readonly server = signal<Record<string, string>>({});
  /** Bumped on every value / status change: the error texts are read from the group in templates (OnPush). */
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
    /** Paths the form renders, in form order (server errors on other paths are the form message). */
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

  /** The current value of a field (reactive: read in templates / computed). */
  valueOf<T = unknown>(path: string): T {
    this.version();
    return this.control(path).value as T;
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

  /** Puts (or with `null` removes) a check of the field itself — a typed date that is not a date — without moving
   * the focus (shown at once, like a server error; it goes when the field changes). */
  fieldError(path: string, message: string | null): void {
    if (message === null) this.clearError(path);
    else this.server.update((s) => ({ ...s, [path]: message }));
  }

  /** A 429 outside `fail` (a failure said elsewhere — a dialog): the submit waits with its countdown. */
  rateLimited(seconds: number): void {
    this.startWait(seconds);
  }

  /** Removes the server / import error of a field. */
  clearError(path: string): void {
    if (!(path in untracked(this.server))) return;
    const rest = { ...untracked(this.server) };
    delete rest[path];
    this.server.set(rest);
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
  /** Field paths the form renders; absent — an action without a form (every error is the message). */
  fields?: readonly string[];
  /** Shows server errors under fields (path → i18n key). */
  mark?: (errors: Record<string, string>) => void;
  /** A server error path → the form field it belongs to. */
  alias?: ((path: string) => string) | undefined;
}

/** Puts a failed request on a form or an action: field errors, a form-level message, or the rate-limit countdown. */
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

/** Form text of a decimal as the wire format wants it: `1,5` → `1.500` for `places` = 3. Anything that is not a plain
 * number is returned as typed, so the shared schema reports it (`validation.*.format`). */
export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

/** A form schema whose values are the form's own (texts, selects) and whose output is the request body (the React
 * app's `wireSchema`): `toWire` builds the body, the shared schema of @agrotrace/validation checks it, and each issue
 * is put on the top-level form field its path starts with (`geometry.coordinates.0` → `geometry`). An empty text or an
 * unchosen select (`''`) is an absent value, so it is reported as «Обязательное поле», not as a bad format.
 * `precheck` — form-only checks before the body is built (field → i18n key), reported first. */
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
