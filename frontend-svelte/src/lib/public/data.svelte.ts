import { onDestroy } from 'svelte';
import { ApiProblem, createPublicApi, retryAfterOf, type PublicBatch } from '@agrotrace/api-client/public';
import { takeEarly } from './early';

export const api = createPublicApi({
  baseUrl: `${location.origin}/api/v1`,
  fetch: (input, init) => takeEarly(String(input)) ?? fetch(input, init),
});

export const PUBLIC_CODE = /^AT-\d{4}-\d{6,}$/;

export type Failure = { kind: 'offline' } | { kind: 'unavailable' } | { kind: 'limited'; wait: number };

export type BatchState =
  | { status: 'loading' }
  | { status: 'ok'; batch: PublicBatch }
  | { status: 'notFound' }
  | { status: 'failed'; failure: Failure; busy: boolean };

export function failureOf(e: unknown): Failure {
  if (e instanceof ApiProblem) {
    if (e.status === 429) return { kind: 'limited', wait: retryAfterOf(e) ?? 60 };
    return { kind: 'unavailable' };
  }
  return { kind: 'offline' };
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity
const known = new Map<string, PublicBatch>();

export class BatchQuery {
  state = $state<BatchState>({ status: 'loading' });
  #code: string;
  #ctl: AbortController | null = null;

  constructor(code: string) {
    this.#code = code;
    const cached = known.get(code);
    if (cached) this.state = { status: 'ok', batch: cached };
    else if (!PUBLIC_CODE.test(code)) this.state = { status: 'notFound' };
    else this.#load();
    onDestroy(() => this.#ctl?.abort());
  }

  retry = (): void => this.#load();

  #load(): void {
    this.#ctl?.abort();
    const ctl = new AbortController();
    this.#ctl = ctl;
    const s = this.state;
    this.state = s.status === 'failed' ? { ...s, busy: true } : { status: 'loading' };
    api.getBatch(this.#code, { signal: ctl.signal }).then(
      (batch) => {
        known.set(this.#code, batch);
        if (!ctl.signal.aborted) this.state = { status: 'ok', batch };
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 400))
          this.state = { status: 'notFound' };
        else this.state = { status: 'failed', failure: failureOf(e), busy: false };
      },
    );
  }
}

export function clearBatchCache(): void {
  known.clear();
}

export class Wait {
  left = $state(0);
  #timer: ReturnType<typeof setInterval> | null = null;

  start(seconds: number): void {
    this.stop();
    this.left = Math.max(1, Math.ceil(seconds));
    this.#timer = setInterval(() => {
      this.left = Math.max(0, this.left - 1);
      if (this.left === 0) this.stop();
    }, 1000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export function focusIfIdle(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

export function initials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toLocaleUpperCase('ru');
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toLocaleUpperCase('ru');
}
