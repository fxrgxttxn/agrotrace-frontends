import { tick } from 'svelte';
import type { ZodTypeAny } from 'zod';
import { ApiProblem } from '@agrotrace/api-client';
import { Countdown, errorText, retryAfterOf } from './api.svelte';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

// Forms (spec §9.2 for Svelte: native forms + the shared Zod schemas of @agrotrace/validation). Error messages are
// i18n keys (from the schemas and from the server's `errors`), translated where they are shown. A failed submit is put
// on the form like the React app does (`applyProblem` there): 400 `errors` under the fields (`items[1].batchId` paths),
// `_root` and unknown paths as one form-level message, 429 → a countdown on the submit, anything else → its text.

/** One form-level message at a time (an error toast, `role="alert"`): a new submit or message replaces it. */
export class FormAlert {
  #id: number | null = null;

  show(text: string, tone: 'danger' | 'attention' = 'danger'): void {
    this.clear();
    this.#id = toasts.push({ tone, text });
  }

  clear(): void {
    if (this.#id !== null) toasts.dismiss(this.#id);
    this.#id = null;
  }
}

/** A form on a shared schema: `values`, `errors` (path → i18n key), `busy`, the 429 countdown and the form message.
 * `fields` lists the rendered field paths in DOM order (the first invalid one takes the focus); each field's control
 * has the id `idOf(path)`. */
export class SchemaForm<F extends Record<string, unknown>> {
  values: F;
  errors = $state<Record<string, string>>({});
  busy = $state(false);
  readonly wait = new Countdown();
  readonly alert = new FormAlert();

  readonly schema: ZodTypeAny;
  readonly fields: readonly string[];
  readonly idOf: (path: string) => string;

  constructor(schema: ZodTypeAny, initial: F, fields: readonly string[], idOf?: (path: string) => string) {
    this.schema = schema;
    this.fields = fields;
    this.idOf = idOf ?? ((p) => p.replace(/[.[\]]+/g, '-').replace(/-$/, ''));
    this.values = $state(initial);
  }

  /** Translated error of a field (or `null`). */
  error(path: string): string | null {
    const key = this.errors[path];
    return key ? t(key) : null;
  }

  /** Client-side check on the schema; marks and focuses the first invalid field. */
  async validate(): Promise<F | null> {
    const parsed = this.schema.safeParse($state.snapshot(this.values));
    if (parsed.success) {
      this.errors = {};
      return parsed.data as F;
    }
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path
        .map((p: string | number) => (typeof p === 'number' ? `[${p}]` : p))
        .join('.')
        .replace(/\.\[/g, '[');
      if (!(path in errors)) errors[path] = issue.message;
    }
    this.errors = errors;
    await this.#focusFirst(Object.keys(errors));
    return null;
  }

  /** Runs `send` with the valid values: busy while sending, failures put on the form. */
  submit(send: (values: F) => Promise<void>): (e: SubmitEvent) => Promise<void> {
    return async (e) => {
      e.preventDefault();
      if (this.busy || this.wait.left > 0) return;
      this.alert.clear();
      const values = await this.validate();
      if (!values) return;
      this.busy = true;
      try {
        await send(values);
      } catch (err) {
        await this.fail(err);
      } finally {
        this.busy = false;
      }
    };
  }

  /** Puts a failed submit on the form: field errors, a form-level message, or the rate-limit countdown. */
  async fail(e: unknown): Promise<void> {
    if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
      const rest: string[] = [];
      const marked: Record<string, string> = {};
      for (const [path, keys] of Object.entries(e.errors)) {
        const key = keys[0];
        if (!key) continue;
        if (this.fields.includes(path)) marked[path] = key;
        else rest.push(t(key));
      }
      this.errors = marked;
      const first = await this.#focusFirst(Object.keys(marked));
      if (rest.length) this.alert.show(rest.join('. '));
      else if (!first) this.alert.show(errorText(e));
      return;
    }
    if (e instanceof ApiProblem && e.status === 429) {
      const seconds = retryAfterOf(e);
      this.wait.start(seconds);
      this.alert.show(t('auth.rateLimited', { seconds }), 'attention');
      return;
    }
    this.alert.show(errorText(e));
  }

  /** Focus goes to the first invalid field in the order of the form (not of the answer). */
  async #focusFirst(paths: string[]): Promise<string | undefined> {
    const first = this.fields.find((f) => paths.includes(f));
    if (!first) return undefined;
    await tick();
    document.getElementById(this.idOf(first))?.focus();
    return first;
  }
}
