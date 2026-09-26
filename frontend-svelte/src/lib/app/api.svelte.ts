import { ApiProblem, type ProblemBody } from '@agrotrace/api-client';
import { enumLabel, problemMessage } from '@agrotrace/i18n';
import { tick } from 'svelte';
import { t } from './i18n';

// Calling the API from screens: every call goes through `call()` (api-client's typed result → data or ApiProblem),
// the server's `Retry-After` of a 429 is kept on the problem. Same rules as the React app (src/app/api.ts there).

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

/** A rate limit is a wait, not a failure: attention tone; everything else is an error. */
export function errorTone(e: unknown): 'danger' | 'attention' {
  return e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger';
}

/** Countdown for a rate-limited action: `start(seconds)`, `left` = seconds remaining (0 — free). */
export class Countdown {
  left = $state(0);
  #timer: ReturnType<typeof setInterval> | null = null;

  start(seconds: number): void {
    this.stop();
    this.left = Math.max(1, Math.ceil(seconds));
    this.#timer = setInterval(() => {
      const left = this.left - 1;
      this.left = Math.max(0, left);
      if (left <= 0) this.stop();
    }, 1000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** Ruling FM17: when a wait ends, the waiting button takes the focus only if nothing else holds it — the focus is on
 * the body, on that button, or on an element that left the document. A field the person moved to keeps it. */
export function focusIfIdle(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

/** The action button a 429 wait disabled (its focus dropped to the page) gets the focus back when it can act again, by
 * the FM17 rule. Call during component initialisation. */
export function focusAfterWait(left: () => number, button: () => HTMLElement | null | undefined): void {
  let waited = false;
  $effect(() => {
    if (left() > 0) waited = true;
    else if (waited) {
      waited = false;
      focusIfIdle(button());
    }
  });
}

/** Ruling FM21: an action removed (or a dialog closed over) the focused control — the focus goes to `opener` if it is
 * still in the document, else to the page title. Only when the focus was lost (nothing else took it). */
export async function restoreFocus(opener: HTMLElement | null | undefined): Promise<void> {
  await tick();
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus();
  else document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
}
