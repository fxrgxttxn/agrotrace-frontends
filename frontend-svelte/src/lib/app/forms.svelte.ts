import { tick } from 'svelte';
import { z, type ZodTypeAny } from 'zod';
import { ApiProblem } from '@agrotrace/api-client';
import { cache, screenAlive } from './cache.svelte';
import { userAction } from './focusRescue';
import { session } from './session.svelte';
import { Countdown, errorText, errorTone, isCancellation, retryAfterOf } from './api.svelte';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

export class FormAlert {
  #id: number | null = null;
  message = $state<string | null>(null);

  show = (text: string, tone: 'danger' | 'attention' = 'danger'): void => {
    this.clear();
    this.message = text;
    this.#id = toasts.push({ tone, text });
  };

  problem = (e: unknown): void => {
    if (!isCancellation(e)) this.show(errorText(e), errorTone(e));
  };

  clear = (): void => {
    this.message = null;
    if (this.#id !== null) toasts.dismiss(this.#id);
    this.#id = null;
  };
}

export class DialogAlert {
  message = $state<string | null>(null);
  #current: { text: string; tone: 'danger' | 'attention' } | null = null;
  readonly #alive = screenAlive();

  show = (text: string, tone: 'danger' | 'attention' = 'danger'): void => {
    this.#current = { text, tone };
    this.message = text;
  };

  problem = (e: unknown): void => {
    if (!isCancellation(e)) this.show(errorText(e), errorTone(e));
  };

  clear = (): void => {
    this.#current = null;
    this.message = null;
  };

  handOff = (): void => {
    const failure = this.#current;
    this.clear();
    if (failure && this.#alive()) toasts.push(failure);
  };
}

export type MessageAlert = FormAlert | DialogAlert;

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
  schema: ZodTypeAny;
  values: F;
  fields: readonly string[];
  toWire?: (values: F) => unknown;
  send: (body: B) => Promise<void>;
  alias?: (path: string) => string;
  alert?: MessageAlert;
}

export class SchemaForm<F extends Record<string, unknown>, B = F> {
  values: F;
  busy = $state(false);
  readonly wait = new Countdown();
  readonly alert: MessageAlert;
  readonly fields: readonly string[];

  #client = $state<Record<string, string>>({});
  #server = $state<Record<string, string>>({});
  #submitted = $state(false);
  #node: HTMLFormElement | null = null;
  readonly #schema: ZodTypeAny;
  readonly #toWire: (values: F) => unknown;
  readonly #send: (body: B) => Promise<void>;
  readonly #alias: ((path: string) => string) | undefined;
  readonly #ownAlert: boolean;
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

  error = (path: string): string | null => {
    const server = this.#server[path];
    if (server) return t(server);
    const client = this.#submitted ? this.#client[path] : undefined;
    return client ? t(client) : null;
  };

  setError(path: string, message: string): void {
    this.#server = { ...this.#server, [path]: message };
    void this.#focusFirstInvalid();
  }

  mark(path: string, message: string | null): void {
    const rest = { ...this.#server };
    delete rest[path];
    this.#server = message ? { ...rest, [path]: message } : rest;
  }

  reset(values: F): void {
    for (const k of Object.keys(values) as (keyof F)[]) this.values[k] = values[k];
    this.#submitted = false;
    this.#client = {};
    this.#server = {};
  }

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

  async submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (this.busy || this.wait.left > 0) return;
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
      await userAction(() => this.#send(parsed.data as B));
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  fail(e: unknown): void {
    if (!this.alive()) return;
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

  alive(): boolean {
    return this.#node !== null && (this.#born === null || cache.generation === this.#born);
  }

  attach(node: HTMLFormElement | null): void {
    this.#node = node;
  }

  release(): void {
    if (this.#ownAlert) this.alert.clear();
    this.wait.stop();
  }

  async #focusFirstInvalid(): Promise<void> {
    await tick();
    this.#node?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }
}

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
  onRateLimit?: (seconds: number) => void;
  fields?: readonly string[];
  mark?: (errors: Record<string, string>) => void;
  alias?: (path: string) => string;
}

export function applyProblem(e: unknown, o: ApplyOptions): void {
  if (isCancellation(e)) return;
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

export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

export function wireSchema<F>(
  shared: ZodTypeAny,
  toWire: (values: F) => unknown,
  precheck?: (values: F) => Record<string, string>,
) {
  return z.custom<F>().transform((values, ctx) => {
    const early = Object.entries(precheck?.(values) ?? {});
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
