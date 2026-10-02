import { tick } from 'svelte';
import { z, type ZodTypeAny } from 'zod';
import { ApiProblem } from '@agrotrace/api-client';
import { cache } from './cache.svelte';
import { userAction } from './focusRescue';
import { session } from './session.svelte';
import { Countdown, errorText, errorTone, isCancellation, retryAfterOf } from './api.svelte';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

// Forms (spec §9.2 for Svelte: native forms + the shared Zod schemas of @agrotrace/validation through the `use:form`
// action). Error messages are i18n keys (from the schemas and from the server's `errors`), translated where they are
// shown. The behaviour of the React forms (React Hook Form + zodResolver, the reference):
//   - nothing is checked before the first submit; from then on the error of a field follows its every change;
//   - a server error of a field stays until that field changes;
//   - a failed submit focuses the first invalid field in form order;
//   - 400 `errors` go under the fields the form renders (`admin.email`, `items[1].batchId` paths), `_root` and other
//     paths become one form-level message (a toast, ruling F7), replaced on the next submit and gone with the form;
//   - a 429 disables the submit with a countdown (attention toast), the submit takes the focus back when the wait is
//     over (FM17: only when the focus is free — `Submit.svelte`);
//   - nothing is trimmed (R36): the body is exactly what was typed.

/** One form-level message at a time (an error toast, `role="alert"`): a new submit or message replaces it. */
export class FormAlert {
  #id: number | null = null;

  show = (text: string, tone: 'danger' | 'attention' = 'danger'): void => {
    this.clear();
    this.#id = toasts.push({ tone, text });
  };

  /** The text of a failed request (a 429 in the attention tone); nothing for a cancellation (FM29). */
  problem = (e: unknown): void => {
    if (!isCancellation(e)) this.show(errorText(e), errorTone(e));
  };

  clear = (): void => {
    if (this.#id !== null) toasts.dismiss(this.#id);
    this.#id = null;
  };
}

/** Error paths of a Zod issue list: `['admin','email']` → `admin.email`, `['items',1,'batchId']` → `items[1].batchId`;
 * the first message of each path. */
function issuesByPath(schema: ZodTypeAny, value: unknown): Record<string, string> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path
      .map((p: string | number) => (typeof p === 'number' ? `[${p}]` : p))
      .join('.')
      .replace(/\.\[/g, '[');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

export interface SchemaFormOptions<F, B> {
  /** The shared schema of the request body. */
  schema: ZodTypeAny;
  /** Initial values of the controls (texts, selects). */
  values: F;
  /** Field paths the form renders, as the `name` of their controls (server errors on other paths are the message). */
  fields: readonly string[];
  /** The request body of the values (default: the values as they are), checked by the schema. */
  toWire?: (values: F) => unknown;
  /** Sends the checked body; a thrown error is put on the form (`fail`). */
  send: (body: B) => Promise<void>;
  /** Server error paths that belong to a field the form renders under another name (`geometry.coordinates[0]` →
   * `geometry`). */
  alias?: (path: string) => string;
  /** The page's own message (FM13: one message at a time, owned by the page so it survives this form going away) —
   * a dialog or card driven by the page uses the page's instance instead of a fresh one. Default: a fresh one. */
  alert?: FormAlert;
}

/** A form on a shared schema. Controls bind to `values` and carry `name` = their path; `<form use:form={f}>` wires the
 * submit and the change tracking. */
export class SchemaForm<F extends Record<string, unknown>, B = F> {
  values: F;
  /** Sending (the submit is `aria-busy`). */
  busy = $state(false);
  readonly wait = new Countdown();
  readonly alert: FormAlert;
  readonly fields: readonly string[];

  #client = $state<Record<string, string>>({});
  #server = $state<Record<string, string>>({});
  #submitted = $state(false);
  #node: HTMLFormElement | null = null;
  readonly #schema: ZodTypeAny;
  readonly #toWire: (values: F) => unknown;
  readonly #send: (body: B) => Promise<void>;
  readonly #alias: ((path: string) => string) | undefined;
  /** Whether `alert` is this form's own (cleared when it unmounts) or the page's (FM13: survives this form). */
  readonly #ownAlert: boolean;
  /** Session generation of the latest submit. */
  #born: number | null = null;

  constructor(o: SchemaFormOptions<F, B>) {
    this.values = $state(o.values);
    this.fields = o.fields;
    this.#schema = o.schema;
    this.#toWire = o.toWire ?? ((v) => v);
    this.#send = o.send;
    this.#alias = o.alias;
    this.#ownAlert = o.alert === undefined;
    this.alert = o.alert ?? new FormAlert();
  }

  /** Translated error of a field (`null` — none). */
  error = (path: string): string | null => {
    const server = this.#server[path];
    if (server) return t(server);
    const client = this.#submitted ? this.#client[path] : undefined;
    return client ? t(client) : null;
  };

  /** Puts an error (an i18n key or a ready text) under a field and focuses the first invalid field. */
  setError(path: string, message: string): void {
    this.#server = { ...this.#server, [path]: message };
    void this.#focusFirstInvalid();
  }

  /** Puts (or, with `null`, takes away) an error under a field without moving the focus — a control's own check, e.g.
   * a date typed in a wrong format, reported on blur (React Hook Form's `setError` / `clearErrors`). */
  mark(path: string, message: string | null): void {
    const rest = { ...this.#server };
    delete rest[path];
    this.#server = message ? { ...rest, [path]: message } : rest;
  }

  /** Back to `values` (after a successful save): no errors until the next submit. */
  reset(values: F): void {
    for (const k of Object.keys(values) as (keyof F)[]) this.values[k] = values[k];
    this.#submitted = false;
    this.#client = {};
    this.#server = {};
  }

  /** The control named `path` changed: its server error goes, its client error follows the value (after a submit). */
  changed(path: string): void {
    if (path in this.#server) {
      const rest = { ...this.#server };
      delete rest[path];
      this.#server = rest;
    }
    if (!this.#submitted) return;
    const now = issuesByPath(this.#schema, this.#toWire($state.snapshot(this.values) as F))[path];
    if (now === this.#client[path]) return;
    const next = { ...this.#client };
    if (now) next[path] = now;
    else delete next[path];
    this.#client = next;
  }

  /** Checks only the given paths (one step of a wizard) without sending: marks their errors (shown from now on,
   * like a submit) and focuses the first invalid one of them; other paths are left exactly as they are. Returns
   * whether all of `paths` are valid. */
  checkFields(paths: readonly string[]): boolean {
    this.#submitted = true;
    const wire = this.#toWire($state.snapshot(this.values) as F);
    const issues = issuesByPath(this.#schema, wire);
    const next = { ...this.#client };
    let ok = true;
    for (const path of paths) {
      const message = issues[path];
      if (message) {
        next[path] = message;
        ok = false;
      } else delete next[path];
    }
    this.#client = next;
    if (!ok) void this.#focusFirstInvalid();
    return ok;
  }

  /** The submit: checks the shared schema, then sends the body (busy meanwhile); a failure goes on the form. */
  async submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (this.busy || this.wait.left > 0) return;
    // FM29: a form of an anonymous screen (login, 2FA, reset…) is never silenced by the session generation
    this.#born = session.status === 'authenticated' ? cache.generation : null;
    this.#submitted = true;
    this.#server = {};
    const wire = this.#toWire($state.snapshot(this.values) as F);
    const parsed = this.#schema.safeParse(wire);
    if (!parsed.success) {
      this.#client = issuesByPath(this.#schema, wire);
      await this.#focusFirstInvalid();
      return;
    }
    this.#client = {};
    this.alert.clear();
    this.busy = true;
    try {
      // the person's own action (FM26): what its answer removes hands the focus to the page title
      await userAction(() => this.#send(parsed.data as B));
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  /** Puts a failed request on the form: field errors, a form-level message, or the rate-limit countdown. */
  fail(e: unknown): void {
    if (!this.alive()) return; // FM26: a late failure after the form or its session is gone is silent
    applyProblem(e, {
      alert: this.alert.show,
      onRateLimit: (seconds) => this.wait.start(seconds),
      fields: this.fields,
      alias: this.#alias,
      mark: (marks) => {
        this.#server = marks;
        void this.#focusFirstInvalid();
      },
    });
  }

  /** FM26: the form is still on screen and its session still lasts — after an `await`, the UI steps of a submit
   * (navigation, toast, focus, message) run only while this is true. */
  alive(): boolean {
    return this.#node !== null && (this.#born === null || cache.generation === this.#born);
  }

  /** `use:form`: the form element (focus of the first invalid field). */
  attach(node: HTMLFormElement | null): void {
    this.#node = node;
  }

  /** The form unmounts: its own message goes with it; the page's (FM13, injected) outlives this form. Its wait
   * always stops — it is this control's own countdown either way. */
  release(): void {
    if (this.#ownAlert) this.alert.clear();
    this.wait.stop();
  }

  /** Focus goes to the first invalid field in the order of the form (not of the answer). */
  async #focusFirstInvalid(): Promise<void> {
    await tick();
    this.#node?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }
}

/** `<form use:form={f}>`: no browser validation, the submit runs `f.submit`, a changed control (`name` = its path)
 * updates its error; the form message goes with the form. */
export function form<F extends Record<string, unknown>, B>(node: HTMLFormElement, f: SchemaForm<F, B>) {
  let current = f;
  current.attach(node);
  node.noValidate = true;
  const submit = (e: SubmitEvent) => void current.submit(e);
  const change = (e: Event) => {
    const name = (e.target as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name) current.changed(name);
  };
  node.addEventListener('submit', submit);
  node.addEventListener('input', change);
  node.addEventListener('change', change);
  return {
    update(next: SchemaForm<F, B>) {
      current.attach(null);
      current = next;
      current.attach(node);
    },
    destroy() {
      node.removeEventListener('submit', submit);
      node.removeEventListener('input', change);
      node.removeEventListener('change', change);
      current.attach(null);
      current.release();
    },
  };
}

export interface ApplyOptions {
  alert: (text: string, tone?: 'danger' | 'attention') => void;
  /** Called for a 429 with the seconds to wait. */
  onRateLimit?: (seconds: number) => void;
  /** Field paths the form renders; absent — an action without a form (every error is the message). */
  fields?: readonly string[];
  /** Shows server errors under fields (path → i18n key). */
  mark?: (errors: Record<string, string>) => void;
  /** Server error paths that belong to another field name. */
  alias?: (path: string) => string;
}

/** Puts a failed request on a form or an action: field errors, a form-level message, or the rate-limit countdown
 * (React's `applyProblem`). */
export function applyProblem(e: unknown, o: ApplyOptions): void {
  if (isCancellation(e)) return; // FM29: nothing to say about a request cancelled on purpose
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

/** Form text of a decimal as the wire format wants it: `1,5` → `1.500` for `places` = 3. Anything that is not a plain
 * number is returned as typed, so the shared schema reports it (`validation.*.format`). */
export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

/** A form schema whose values are the form's own (texts, selects) and whose output is the request body: `toWire`
 * builds the body, the shared schema of @agrotrace/validation checks it, and each issue is put on the top-level form
 * field its path starts with (`geometry.coordinates.0` → `geometry`). An empty text or an unchosen select (`''`) is an
 * absent value, so it is reported as «Обязательное поле», not as a bad format. As the React app's `wireSchema`. */
export function wireSchema<F>(
  shared: ZodTypeAny,
  toWire: (values: F) => unknown,
  /** Form-only checks before the body is built (e.g. text that must parse as JSON): field → i18n key. */
  precheck?: (values: F) => Record<string, string>,
) {
  return z.custom<F>().transform((values, ctx) => {
    // Form checks and the shared schema both report (one message per field, the form check first).
    const early = Object.entries(precheck?.(values) ?? {});
    // Local to this transform, not component state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const marked = new Set(early.map(([path]) => path));
    for (const [path, message] of early) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const wire = toWire(values) as Record<string, unknown>;
    const body = Object.fromEntries(Object.entries(wire).filter(([, v]) => v !== '' && v !== undefined));
    const res = shared.safeParse(body);
    if (res.success && early.length === 0) return res.data as unknown;
    for (const issue of res.success ? [] : res.error.issues) {
      const path = issue.path.slice(0, 1);
      if (marked.has(String(path[0]))) continue;
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: issue.message });
    }
    return z.NEVER;
  });
}
