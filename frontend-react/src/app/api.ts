import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { enumLabel, problemMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { useScreenAlive } from './cache';
import { useToast } from '../ui/Toasts';

export { useCountdown, focusIfIdle, useFocusAfterWait } from '../ui/wait';

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

/** One form-level message at a time (an error toast, `role="alert"`): a new submit or message replaces it. */
export function useFormAlert(): {
  show: (text: string, tone?: 'danger' | 'attention') => void;
  clear: () => void;
} {
  // FM26: a message of a screen that is gone (or of an ended session) is not shown.
  const toast = useToast();
  const alive = useScreenAlive();
  const id = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (id.current !== null) toast.dismiss(id.current);
    id.current = null;
  }, [toast]);
  const show = useCallback(
    (text: string, tone: 'danger' | 'attention' = 'danger') => {
      clear();
      if (alive()) id.current = toast.push({ tone, text });
    },
    [toast, clear, alive],
  );
  useEffect(() => clear, [clear]);
  return { show, clear };
}

export interface DialogAlert {
  /** The failure said in the dialog (`DialogMessage`), null — none. */
  message: string | null;
  show: (text: string, tone?: 'danger' | 'attention') => void;
  /** A new attempt or a success: the failure no longer applies. */
  clear: () => void;
  /** The dialog closes (Отмена, the cross, Esc, or the screen closes it): a failure that still applies goes to the
   * page as a toast. */
  handOff: () => void;
}

/** README «Диалог» (polish P1): a failure inside an open modal dialog is said once — in the dialog's `role="alert"`,
 * never at the same time as a page toast (the toast region is behind the modal, and both would be announced). When
 * the dialog closes while the failure still applies (no retry or success cleared it), the page gets it as a toast. */
export function useDialogAlert(): DialogAlert {
  const toast = useToast();
  const alive = useScreenAlive();
  const [message, setMessage] = useState<string | null>(null);
  const current = useRef<{ text: string; tone: 'danger' | 'attention' } | null>(null);
  const show = useCallback((text: string, tone: 'danger' | 'attention' = 'danger') => {
    current.current = { text, tone };
    setMessage(text);
  }, []);
  const clear = useCallback(() => {
    current.current = null;
    setMessage(null);
  }, []);
  const handOff = useCallback(() => {
    const failure = current.current;
    clear();
    // FM26: a failure of a screen that is gone (or of an ended session) is not shown.
    if (failure && alive()) toast.push(failure);
  }, [clear, alive, toast]);
  return useMemo(() => ({ message, show, clear, handOff }), [message, show, clear, handOff]);
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
