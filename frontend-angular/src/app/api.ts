import { signal, type Signal, DestroyRef, inject } from '@angular/core';
import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { enumLabel, problemMessage } from '@agrotrace/i18n';
import { t } from './i18n';

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
  throw problem;
}

export function retryAfterOf(p: ApiProblem): number {
  const header = RETRY_AFTER.get(p);
  if (header) return header;
  const window = Number(p.params?.['windowSec']);
  return Number.isFinite(window) && window > 0 ? window : 60;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiProblem) {
    if (e.code === 'FORBIDDEN' && typeof e.params?.['reason'] === 'string') {
      const code = typeof e.params['publicCode'] === 'string' ? e.params['publicCode'] : null;
      const status =
        typeof e.params['status'] === 'string' ? enumLabel(t, 'BatchStatus', e.params['status']) : '';
      const key = `auth.forbidden.${e.params['reason']}${code ? '_CODE' : ''}`;
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

export function countdown(): { left: Signal<number>; start: (seconds: number) => void } {
  const left = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  inject(DestroyRef).onDestroy(stop);
  return {
    left,
    start: (seconds: number) => {
      stop();
      left.set(Math.max(1, Math.ceil(seconds)));
      timer = setInterval(() => {
        left.update((s) => s - 1);
        if (left() <= 0) stop();
      }, 1000);
    },
  };
}
