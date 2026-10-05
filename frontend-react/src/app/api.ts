import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { enumLabel, problemMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { useScreenAlive } from './cache';
import { useToast } from '../ui/Toasts';

export { useCountdown, focusIfIdle, useFocusAfterWait } from '../ui/wait';

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

const RETRY_AFTER = new WeakMap<ApiProblem, number>();

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

export function retryAfterOf(p: ApiProblem): number {
  const header = RETRY_AFTER.get(p);
  if (header) return header;
  const window = Number(p.params?.windowSec);
  return Number.isFinite(window) && window > 0 ? window : 60;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiProblem) {
    if (e.code === 'FORBIDDEN' && typeof e.params?.reason === 'string') {
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

export function fieldText(message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

export function useFormAlert(): {
  show: (text: string, tone?: 'danger' | 'attention') => void;
  clear: () => void;
} {
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
  message: string | null;
  show: (text: string, tone?: 'danger' | 'attention') => void;
  clear: () => void;
  handOff: () => void;
}

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
    if (failure && alive()) toast.push(failure);
  }, [clear, alive, toast]);
  return useMemo(() => ({ message, show, clear, handOff }), [message, show, clear, handOff]);
}

export interface ApplyOptions<F extends FieldValues> {
  form?: UseFormReturn<F>;
  fields?: readonly Path<F>[];
  alert: (text: string, tone?: 'danger' | 'attention') => void;
  onRateLimit?: (seconds: number) => void;
  alias?: (path: string) => string;
}

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

export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}
