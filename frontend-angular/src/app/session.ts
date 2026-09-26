import { computed, DestroyRef, inject, Injectable, InjectionToken, NgZone, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom, filter, Subject } from 'rxjs';
import {
  ApiProblem,
  createApi,
  createMemoryTokenStore,
  type Api,
  type LoginSuccess,
  type Me,
  type TokenStore,
} from '@agrotrace/api-client';
import { call, retryAfterOf } from './api';
import { t } from './i18n';
import { ToastService } from './ui/toasts';

// Session (spec §9.2 «injectable-сервисы с signals», rulings R32/R61/R62, F8): the access token lives in memory only
// (createMemoryTokenStore); the refresh token is the httpOnly `at_refresh` cookie. At start the app restores the
// session from the cookie (`POST /auth/refresh`, serialized across tabs by api-client's Web Lock) and loads `/me`.
// A session lost for good (refresh 401/403) sends the user to `/login?next=<where they were>`; a transient failure
// (network, 5xx, 429) never logs out (R61, F8). Logout is broadcast to the other tabs.

/** Wait after a 429 of `/auth/refresh`: api-client reports it as a transient problem without its Retry-After. */
const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
export const SESSION_CHANNEL = 'agrotrace-session';

/** Absolute API base: `Request` outside a browser page (tests) needs an absolute URL. */
export function apiBaseUrl(): string {
  return `${location.origin}${API_BASE}`;
}

export interface SessionCore {
  store: TokenStore;
  api: Api;
  /** Replaced by the session service: what to do when the session is lost for good. */
  onAuthLost: { current: () => void };
}

export function createSessionCore(fetchImpl?: typeof fetch): SessionCore {
  const store = createMemoryTokenStore();
  const onAuthLost = { current: () => {} };
  const api = createApi({
    baseUrl: apiBaseUrl(),
    session: store,
    onAuthLost: () => onAuthLost.current(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { store, api, onAuthLost };
}

export const SESSION_CORE = new InjectionToken<SessionCore>('SESSION_CORE');

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; loggedOut?: boolean }
  | { status: 'unavailable'; retryAfter?: number }
  | { status: 'authenticated'; me: Me };

/** A `next` target is only ever a same-origin path (no open redirect), never an auth screen. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login/') || raw.startsWith('/login?')) return '/';
  return raw.split('#', 1)[0] || '/'; // never the #fragment (FM10)
}

/** `/login?next=…` for a path the user has to sign in for (plain `/login` for the home page); a `#fragment` is never
 * carried (FM10). */
export function loginUrl(here: string): string {
  const next = safeNext(here);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly core = inject(SESSION_CORE);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly zone = inject(NgZone);
  readonly api: Api = this.core.api;
  readonly store: TokenStore = this.core.store;

  private readonly stateSignal = signal<SessionState>({ status: 'loading' });
  readonly state = this.stateSignal.asReadonly();
  /** The same state as a stream (guards wait on it). */
  readonly state$ = new BehaviorSubject<SessionState>({ status: 'loading' });
  readonly status = computed(() => this.state().status);
  /** The signed-in user (`null` otherwise). */
  readonly me = computed(() => {
    const s = this.state();
    return s.status === 'authenticated' ? s.me : null;
  });
  /** The session ended here (logout, loss, another tab): server-data caches drop what they hold. */
  readonly ended$ = new Subject<void>();
  /** Guards waiting for the start-up restore (the root shows the loading page meanwhile). */
  readonly waiting = signal(0);

  private booting = true;
  private channel: BroadcastChannel | null = null;

  constructor() {
    this.core.onAuthLost.current = () =>
      this.zone.run(() => {
        if (this.booting) return; // start-up without a cookie is simply «not signed in»
        this.endLocally();
        this.toasts.push({ tone: 'attention', text: t('errors.TOKEN_EXPIRED') });
        void this.router.navigateByUrl(loginUrl(this.router.url), { replaceUrl: true });
      });
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(SESSION_CHANNEL);
      this.channel = ch;
      ch.onmessage = (e: MessageEvent) =>
        this.zone.run(() => {
          if ((e.data as { type?: string } | null)?.type !== 'logout') return;
          this.endLocally(true);
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        });
    }
    inject(DestroyRef).onDestroy(() => {
      this.core.onAuthLost.current = () => {};
      this.channel?.close();
      this.channel = null;
    });
    void this.restore();
  }

  private set(next: SessionState): void {
    this.stateSignal.set(next);
    this.state$.next(next);
  }

  /** Resolves once the start-up restore has an answer (not `loading`). */
  async settled(): Promise<SessionState> {
    const now = this.state$.value;
    if (now.status !== 'loading') return now;
    this.waiting.update((n) => n + 1);
    try {
      return await firstValueFrom(this.state$.pipe(filter((s) => s.status !== 'loading')));
    } finally {
      this.waiting.update((n) => n - 1);
    }
  }

  /** Start-up restore (and its retry after a transient failure): refresh from the cookie, then `/me`. */
  async restore(): Promise<void> {
    this.booting = true;
    this.set({ status: 'loading' });
    try {
      const token = this.store.get() ?? (await this.api.refresh());
      if (!token) {
        this.set({ status: 'anonymous' });
        return;
      }
      this.set({ status: 'authenticated', me: await this.loadMe() });
    } catch (e) {
      // R61/F8: a network error, a 5xx or a rate limit (429 of /auth/refresh or /me) is not a logout — the session is
      // kept and a retry is offered (after Retry-After for a 429) instead of the login screen.
      if (e instanceof ApiProblem && e.status === 429)
        this.set({
          status: 'unavailable',
          retryAfter: e.code === 'RATE_LIMITED' ? retryAfterOf(e) : REFRESH_429_WAIT,
        });
      else if (e instanceof ApiProblem && (e.status === 0 || e.status >= 500))
        this.set({ status: 'unavailable' });
      else if (e instanceof TypeError) this.set({ status: 'unavailable' });
      else {
        this.store.set(null);
        this.set({ status: 'anonymous' });
      }
    } finally {
      this.booting = false;
    }
  }

  private loadMe(): Promise<Me> {
    return call<Me>(this.api.GET('/me'));
  }

  // `loggedOut`: an explicit logout (here or in another tab) goes to a plain /login — no `next` back into the cabinet.
  private endLocally(loggedOut = false): void {
    this.store.set(null);
    this.set(loggedOut ? { status: 'anonymous', loggedOut: true } : { status: 'anonymous' });
    this.ended$.next();
  }

  /** Installs a successful login (`POST /auth/login` or `/auth/2fa/verify`). */
  signIn(result: LoginSuccess): void {
    this.store.set(result.accessToken);
    this.set({ status: 'authenticated', me: result.user as Me });
  }

  /** `POST /auth/logout`, clears the session here and in the other tabs, then goes to `to` (default `/login`). */
  async signOut(to = '/login'): Promise<void> {
    try {
      await this.api.POST('/auth/logout');
    } catch {
      // Even when the server is unreachable the local session ends; the cookie expires on its own.
    }
    this.endLocally(true);
    this.channel?.postMessage({ type: 'logout' });
    await this.router.navigateByUrl(to, { replaceUrl: true });
  }

  /** Reloads `/me` (after a profile change). */
  async reloadMe(): Promise<void> {
    this.set({ status: 'authenticated', me: await this.loadMe() });
  }

  /** Installs a profile the API just returned (`PATCH /me`). */
  setMe(me: Me): void {
    this.set({ status: 'authenticated', me });
  }
}
