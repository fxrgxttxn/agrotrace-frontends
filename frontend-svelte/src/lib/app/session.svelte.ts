import { goto } from './goto';
import { stripBase } from './paths';
import {
  ApiProblem,
  createApi,
  createMemoryTokenStore,
  type Api,
  type LoginSuccess,
  type Me,
  type TokenStore,
} from '@agrotrace/api-client';
import { call, retryAfterOf } from './api.svelte';
import { cache } from './cache.svelte';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
export const SESSION_CHANNEL = 'agrotrace-session';

export function apiBaseUrl(): string {
  return `${location.origin}${API_BASE}`;
}

export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login/') || raw.startsWith('/login?')) return '/';
  return raw;
}

export function loginUrl(here: string): string {
  const next = safeNext(here);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}

export type SessionStatus = 'loading' | 'anonymous' | 'unavailable' | 'authenticated';

export interface SessionOptions {
  fetch?: typeof fetch;
}

export class Session {
  status = $state<SessionStatus>('loading');
  me = $state<Me | null>(null);
  loggedOut = $state(false);
  retryAfter = $state<number | undefined>(undefined);

  store: TokenStore;
  api: Api;
  #booting = true;
  #userRetry = false;
  #run = 0;
  #voidRun: (() => void) | null = null;
  #started: Promise<void> | null = null;
  #channel: BroadcastChannel | null = null;

  constructor(options: SessionOptions = {}) {
    this.store = createMemoryTokenStore();
    this.api = createApi({
      baseUrl: apiBaseUrl(),
      session: this.store,
      onAuthLost: () => this.#authLost(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (typeof BroadcastChannel !== 'undefined') {
      this.#channel = new BroadcastChannel(SESSION_CHANNEL);
      this.#channel.onmessage = (e: MessageEvent) => {
        if ((e.data as { type?: string } | null)?.type !== 'logout') return;
        if (this.status === 'authenticated') {
          this.#end(true);
          void goto('/login', { replaceState: true });
        } else if (this.#voidRun) {
          this.#voidWaitingRun();
          this.store.set(null);
          this.#set('anonymous');
          this.loggedOut = true;
        } else this.store.set(null);
      };
    }
  }

  start(): Promise<void> {
    this.#started ??= this.restore();
    return this.#started;
  }

  retry(): Promise<void> {
    this.#userRetry = true;
    return this.restore();
  }

  takeUserRetry(): boolean {
    const was = this.#userRetry;
    this.#userRetry = false;
    return was;
  }

  async restore(): Promise<void> {
    this.#voidWaitingRun();
    const run = ++this.#run;
    this.#booting = true;
    this.#set('loading');
    const generation = cache.generation;
    let voided = false;
    const gone = new Promise<void>((resolve) => {
      this.#voidRun = () => {
        voided = true;
        resolve();
      };
    });
    const overtaken = (): boolean => voided || run !== this.#run || generation !== cache.generation;
    const settle = async <T>(p: Promise<T>): Promise<T | undefined> => {
      const r = await Promise.race([p.then((v) => ({ v })), gone]);
      return r ? r.v : undefined;
    };
    try {
      const token = this.store.get() ?? (await settle(this.api.refresh()));
      if (overtaken()) return;
      if (!token) {
        this.#set('anonymous');
        return;
      }
      const me = await settle(call<Me>(this.api.GET('/me')));
      if (!overtaken() && me) this.#authenticated(me);
    } catch (e) {
      if (overtaken()) return;
      if (e instanceof ApiProblem && e.status === 429)
        this.#set('unavailable', e.code === 'RATE_LIMITED' ? retryAfterOf(e) : REFRESH_429_WAIT);
      else if (e instanceof ApiProblem && (e.status === 0 || e.status >= 500)) this.#set('unavailable');
      else if (e instanceof TypeError) this.#set('unavailable');
      else {
        this.store.set(null);
        this.#set('anonymous');
      }
    } finally {
      if (run === this.#run) {
        this.#booting = false;
        this.#voidRun = null;
      }
    }
  }

  #voidWaitingRun(): void {
    const end = this.#voidRun;
    this.#voidRun = null;
    if (!end) return;
    this.#run += 1;
    this.#booting = false;
    end();
  }

  signIn(result: LoginSuccess): void {
    this.#voidWaitingRun();
    cache.clear();
    this.store.set(result.accessToken);
    this.#authenticated(result.user as Me);
  }

  async signOut(to = '/login'): Promise<void> {
    try {
      await this.api.POST('/auth/logout');
    } catch {}
    this.#end(true);
    this.#channel?.postMessage({ type: 'logout' });
    await goto(to, { replaceState: true });
  }

  async reloadMe(): Promise<boolean> {
    const generation = cache.generation;
    if (this.status !== 'authenticated') return false;
    try {
      const me = await cache.fetch(['me'], () => call<Me>(this.api.GET('/me')));
      return this.setMe(me, generation);
    } catch {
      return false;
    }
  }

  setMe(me: Me, generation: number): boolean {
    if (generation !== cache.generation || this.status !== 'authenticated') return false;
    this.#authenticated(me);
    return true;
  }

  patchMe(patch: Partial<Me>, generation: number): boolean {
    return this.me !== null && this.setMe({ ...this.me, ...patch }, generation);
  }

  dispose(): void {
    this.api.dispose();
    this.#channel?.close();
    this.#channel = null;
  }

  #authenticated(me: Me): void {
    this.#userRetry = false;
    this.me = me;
    this.retryAfter = undefined;
    this.loggedOut = false;
    this.status = 'authenticated';
  }

  #set(status: Exclude<SessionStatus, 'authenticated'>, retryAfter?: number): void {
    this.me = null;
    this.loggedOut = false;
    this.retryAfter = retryAfter;
    this.status = status;
  }

  #end(loggedOut: boolean): void {
    this.store.set(null);
    if (this.status === 'authenticated') cache.clear();
    this.#set('anonymous');
    this.loggedOut = loggedOut;
  }

  #authLost(): void {
    if (this.#booting) return;
    this.#end(false);
    toasts.push({ tone: 'attention', text: t('errors.TOKEN_EXPIRED') });
    void goto(loginUrl(`${stripBase(location.pathname)}${location.search}`), { replaceState: true });
  }
}

export let session = new Session();

export function resetSession(options: SessionOptions = {}): Session {
  session.dispose();
  session = new Session(options);
  return session;
}
