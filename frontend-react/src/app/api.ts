import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { enumLabel, problemMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { useToast } from '../ui/Toasts';

// Calling the API from screens: every call goes through `call()` (api-client's typed result → data or ApiProblem),
// the server's `Retry-After` of a 429 is kept on the problem, and forms map a problem onto their fields
// (`applyProblem`): 400 `errors` by field path (`admin.email`, `items[1].batchId`), `_root` and unknown paths as a
// form-level message, any other problem as its `problemMessage` text.

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

const RETRY_AFTER = new WeakMap<ApiProblem, number>();

/** Data of a successful answer; throws `ApiProblem` (with `Retry-After` remembered for a 429) otherwise. A network
 * failure rejects with the fetch `TypeError` as it is. */
export async function call<T>(request: Promise<Result<T>>): Promise<T> {
  const res = await request;
  if (res.error === undefined) return res.data as T;
  const body =
    res.error && typeof res.error === 'object' && 'code' in res.error
      ? (res.error as ProblemBody)
      : ({
          type: '/problems/internal',
          title: 'Error',
          status: res.response.status,
          code: 'INTERNAL',
        } as ProblemBody);
  const problem = new ApiProblem(body, res.response.status);
  const retry = Number(res.response.headers.get('Retry-After'));
  if (Number.isFinite(retry) && retry > 0) RETRY_AFTER.set(problem, Math.ceil(retry));
  return Promise.reject(problem);
}

/** Seconds to wait after a 429: `Retry-After`, else the window of the limit, else a minute. */
export function retryAfterOf(p: ApiProblem): number {
  const header = RETRY_AFTER.get(p);
  if (header) return header;
  const window = Number(p.params?.windowSec);
  return Number.isFinite(window) && window > 0 ? window : 60;
}

/** Display text of any error thrown by an API call. */
export function errorText(e: unknown): string {
  if (e instanceof ApiProblem) {
    if (e.code === 'FORBIDDEN' && typeof e.params?.reason === 'string') {
      // The other side of an operation (NOT_HOLDER, NOT_SENDER, NOT_RECEIVER) or a state (BATCH_STATUS): the reason's
      // own text, with the batch code when the answer names it.
      const code = typeof e.params.publicCode === 'string' ? e.params.publicCode : null;
      const status = typeof e.params.status === 'string' ? enumLabel(t, 'BatchStatus', e.params.status) : '';
      const key = `auth.forbidden.${e.params.reason}${code ? '_CODE' : ''}`;
      const text = t(key, { publicCode: code ?? '', status });
      if (text !== key) return text;
    }
    if (e.status === 429) return t('auth.rateLimited', { seconds: retryAfterOf(e) });
    if (e.code === 'VALIDATION' && e.errors) {
      const texts = Object.values(e.errors).flatMap((keys) => (keys[0] ? [t(keys[0])] : []));
      if (texts.length) return texts.join('. ');
    }
    return problemMessage(e, t);
  }
  return t('errors.BACKEND_UNAVAILABLE');
}

/** Error text of a form field: messages are i18n keys (Zod schemas and server `errors`) or ready text. */
export function fieldText(message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

/** Countdown for a rate-limited form: `start(seconds)`, `left` = seconds remaining (0 — free). */
export function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const start = useCallback((seconds: number) => setLeft(Math.max(1, Math.ceil(seconds))), []);
  return [left, start];
}

/** One form-level message at a time (an error toast, `role="alert"`): a new submit or message replaces it. */
export function useFormAlert(): {
  show: (text: string, tone?: 'danger' | 'attention') => void;
  clear: () => void;
} {
  const toast = useToast();
  const id = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (id.current !== null) toast.dismiss(id.current);
    id.current = null;
  }, [toast]);
  const show = useCallback(
    (text: string, tone: 'danger' | 'attention' = 'danger') => {
      clear();
      id.current = toast.push({ tone, text });
    },
    [toast, clear],
  );
  useEffect(() => clear, [clear]);
  return { show, clear };
}

export interface ApplyOptions<F extends FieldValues> {
  /** Absent for an action without a form: every server error becomes the message. */
  form?: UseFormReturn<F>;
  /** Field paths the form renders (server `errors` on other paths become the form-level message). */
  fields?: readonly Path<F>[];
  alert: (text: string, tone?: 'danger' | 'attention') => void;
  /** Called for a 429 with the seconds to wait. */
  onRateLimit?: (seconds: number) => void;
  /** Maps a server path onto the form field that shows it (`geometry.coordinates[0]` → `geometry`). */
  alias?: (path: string) => string;
}

/** Puts a failed submit on the form: field errors, a form-level message, or the rate-limit countdown. */
export function applyProblem<F extends FieldValues>(e: unknown, o: ApplyOptions<F>): void {
  if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
    const rest: string[] = [];
    const fields = (o.fields ?? []) as readonly string[];
    const marked = new Set<string>();
    for (const [raw, keys] of Object.entries(e.errors)) {
      const path = o.alias ? o.alias(raw) : raw;
      const key = keys[0];
      if (!key) continue;
      if (o.form && fields.includes(path) && !marked.has(path)) {
        o.form.setError(path as Path<F>, { type: 'server', message: key });
        marked.add(path);
      } else if (!marked.has(path)) rest.push(t(key));
    }
    // Focus the first invalid field in the order of the form (`fields` is listed in DOM order), not of the answer.
    const firstField = fields.find((f) => marked.has(f));
    if (o.form && firstField) o.form.setFocus(firstField as Path<F>);
    if (rest.length) o.alert(rest.join('. '));
    else if (!firstField) o.alert(errorText(e));
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

/** A rate limit is a wait, not a failure: attention tone; everything else is an error. */
export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}

/** Ruling FM17: when a wait ends, the waiting button takes the focus only if nothing else holds it — the focus is on
 * the body, on that button, or on an element that left the document. A field the person moved to keeps it. */
export function focusIfIdle(button: HTMLElement | null): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

/** The action button a 429 wait disabled (its focus dropped to the page): it gets the focus back when it can act again
 * (as the «Повторить» of the unavailable screen, F8), by the FM17 rule (`focusIfIdle`). Put the returned ref on the
 * button. */
export function useFocusAfterWait(wait: number) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const waited = useRef(false);
  useEffect(() => {
    if (wait > 0) waited.current = true;
    else if (waited.current) {
      waited.current = false;
      focusIfIdle(ref.current);
    }
  }, [wait]);
  return ref;
}
