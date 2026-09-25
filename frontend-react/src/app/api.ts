import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { problemMessage } from '@agrotrace/i18n';
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
      const key = `auth.forbidden.${e.params.reason}`;
      const text = t(key);
      if (text !== key) return text;
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
}

/** Puts a failed submit on the form: field errors, a form-level message, or the rate-limit countdown. */
export function applyProblem<F extends FieldValues>(e: unknown, o: ApplyOptions<F>): void {
  if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
    const rest: string[] = [];
    let first = true;
    for (const [path, keys] of Object.entries(e.errors)) {
      const key = keys[0];
      if (!key) continue;
      if (o.form && ((o.fields ?? []) as readonly string[]).includes(path)) {
        o.form.setError(path as Path<F>, { type: 'server', message: key }, { shouldFocus: first });
        first = false;
      } else rest.push(t(key));
    }
    if (rest.length) o.alert(rest.join('. '));
    else if (first) o.alert(errorText(e));
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
