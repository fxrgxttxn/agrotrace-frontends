import { goto } from '$app/navigation';
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

// Session (spec §9.2 «runes-сторы», rulings R32/R61/R62, F8): the access token lives in memory only
// (createMemoryTokenStore); the refresh token is the httpOnly `at_refresh` cookie. At start the app restores the
// session from the cookie (`POST /auth/refresh`, serialized across tabs by api-client's Web Lock) and loads `/me`.
// A session lost for good (refresh 401/403) sends the user to `/login?next=<where they were>`; a transient failure
// (network, 5xx, 429 — F8) never logs out (R61). Logout is broadcast to the other tabs. The same behaviour as the
// React app (src/app/session.tsx there).

/** Wait after a 429 of `/auth/refresh`: api-client reports it as a transient problem without its Retry-After. */
const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
export const SESSION_CHANNEL = 'agrotrace-session';

/** Absolute API base: `Request` outside a browser page (tests) needs an absolute URL. */
export function apiBaseUrl(): string {
  return `${location.origin}${API_BASE}`;
}

/** A `next` target is only ever a same-origin path (no open redirect), never an auth screen. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login/') || raw.startsWith('/login?')) return '/';
  return raw;
}

/** `/login`, or `/login?next=<path>` for anything but home. */
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
  /** The signed-in user (`authenticated` only). */
  me = $state<Me | null>(null);
  /** `anonymous` after an explicit logout (here or in another tab): a plain /login, no `next`. */
  loggedOut = $state(false);
  /** `unavailable` after a 429: seconds to wait before the retry. */
  retryAfter = $state<number | undefined>(undefined);

  store: TokenStore;
  api: Api;
  #booting = true;
  #userRetry = false;
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
        if ((e.data as { type?: string } | null)?.type === 'logout') {
          this.#end(true);
          void goto('/login', { replaceState: true });
        }
      };
    }
  }

  /** The start-up restore, once; every guard awaits it. */
  start(): Promise<void> {
    this.#started ??= this.restore();
    return this.#started;
  }

  /** «Повторить» after a transient failure: a restore the user asked for (the screen it leads to takes the focus). */
  retry(): Promise<void> {
    this.#userRetry = true;
    return this.restore();
  }

  /** FM10: whether the «Сервис недоступен» screen now showing comes from the user's own retry (read once). */
  takeUserRetry(): boolean {
    const was = this.#userRetry;
    this.#userRetry = false;
    return was;
  }

  /** Restores the session from the refresh cookie (start-up, and «Повторить» after a transient failure). */
  async restore(): Promise<void> {
    this.#booting = true;
    this.#set('loading');
    try {
      const token = this.store.get() ?? (await this.api.refresh());
      if (!token) {
        this.#set('anonymous');
        return;
      }
      this.#authenticated(await call<Me>(this.api.GET('/me')));
    } catch (e) {
      // R61/F8: a network error, a 5xx or a rate limit (429 of /auth/refresh or /me) is not a logout — the session is
      // kept and a retry is offered (after Retry-After for a 429) instead of the login screen.
      if (e instanceof ApiProblem && e.status === 429)
        this.#set('unavailable', e.code === 'RATE_LIMITED' ? retryAfterOf(e) : REFRESH_429_WAIT);
      else if (e instanceof ApiProblem && (e.status === 0 || e.status >= 500)) this.#set('unavailable');
      else if (e instanceof TypeError) this.#set('unavailable');
      else {
        this.store.set(null);
        this.#set('anonymous');
      }
    } finally {
      this.#booting = false;
    }
  }

  /** Installs a successful login (`POST /auth/login` or `/auth/2fa/verify`). */
  signIn(result: LoginSuccess): void {
    this.store.set(result.accessToken);
    this.#authenticated(result.user as Me);
  }

  /** `POST /auth/logout`, clears the session here and in the other tabs, then goes to `to` (default `/login`). */
  async signOut(to = '/login'): Promise<void> {
    try {
      await this.api.POST('/auth/logout');
    } catch {
      // Even when the server is unreachable the local session ends; the cookie expires on its own.
    }
    this.#end(true);
    this.#channel?.postMessage({ type: 'logout' });
    await goto(to, { replaceState: true });
  }

  /** Reloads `/me` (after a profile change). */
  async reloadMe(): Promise<void> {
    this.#authenticated(await call<Me>(this.api.GET('/me')));
  }

  /** Installs a profile the API just returned (`PATCH /me`). */
  setMe(me: Me): void {
    this.#authenticated(me);
  }

  /** Stops the API client and the tab channel (tests; a page never ends its session object). */
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

  /** `loggedOut`: an explicit logout (here or in another tab) goes to a plain /login. */
  #end(loggedOut: boolean): void {
    this.store.set(null);
    cache.clear();
    this.#set('anonymous');
    this.loggedOut = loggedOut;
  }

  #authLost(): void {
    if (this.#booting) return; // start-up without a cookie is simply «not signed in»
    this.#end(false);
    toasts.push({ tone: 'attention', text: t('errors.TOKEN_EXPIRED') });
    void goto(loginUrl(`${location.pathname}${location.search}`), { replaceState: true });
  }
}

/** The app's one session (a module singleton: guards in `+layout.ts`/`+page.ts` and components share it). */
export let session = new Session();

/** Tests: a fresh session (the previous one is disposed). */
export function resetSession(options: SessionOptions = {}): Session {
  session.dispose();
  session = new Session(options);
  return session;
}
