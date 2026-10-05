import { trackRequest } from './actions';
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

const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
export const SESSION_CHANNEL = 'agrotrace-session';

export function apiBaseUrl(): string {
  return `${location.origin}${API_BASE}`;
}

export interface SessionCore {
  store: TokenStore;
  api: Api;
  onAuthLost: { current: () => void };
}

export function createSessionCore(fetchImpl?: typeof fetch): SessionCore {
  const store = createMemoryTokenStore();
  const onAuthLost = { current: () => {} };
  const api = createApi({
    baseUrl: apiBaseUrl(),
    session: store,
    onAuthLost: () => onAuthLost.current(),
    fetch: (input, init) => trackRequest(() => (fetchImpl ?? globalThis.fetch)(input, init)),
  });
  return { store, api, onAuthLost };
}

export const SESSION_CORE = new InjectionToken<SessionCore>('SESSION_CORE');

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; loggedOut?: boolean }
  | { status: 'unavailable'; retryAfter?: number }
  | { status: 'authenticated'; me: Me };

export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login/') || raw.startsWith('/login?')) return '/';
  return raw.split('#', 1)[0] || '/';
}

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
  readonly state$ = new BehaviorSubject<SessionState>({ status: 'loading' });
  readonly status = computed(() => this.state().status);
  readonly me = computed(() => {
    const s = this.state();
    return s.status === 'authenticated' ? s.me : null;
  });
  readonly ended$ = new Subject<void>();
  readonly waiting = signal(0);

  private booting = true;
  private restoreRun = 0;
  private gen = 0;
  private channel: BroadcastChannel | null = null;

  constructor() {
    this.core.onAuthLost.current = () =>
      this.zone.run(() => {
        if (this.booting) return;
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
          if (this.endLocally(true)) void this.router.navigateByUrl('/login', { replaceUrl: true });
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

  async restore(): Promise<void> {
    this.booting = true;
    this.set({ status: 'loading' });
    const generation = this.gen;
    const run = ++this.restoreRun;
    const stale = () => generation !== this.gen || run !== this.restoreRun;
    try {
      const token = this.store.get() ?? (await this.api.refresh());
      if (stale()) return;
      if (!token) {
        this.set({ status: 'anonymous' });
        return;
      }
      const me = await this.loadMe();
      if (!stale()) this.set({ status: 'authenticated', me });
    } catch (e) {
      if (stale()) return;
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
      if (run === this.restoreRun) this.booting = false;
    }
  }

  private loadMe(): Promise<Me> {
    return call<Me>(this.api.GET('/me'));
  }

  private endLocally(loggedOut = false): boolean {
    const had = this.state().status === 'authenticated';
    this.store.set(null);
    if (this.state().status === 'loading') {
      this.restoreRun++;
      this.booting = false;
      this.set({ status: 'anonymous' });
      return false;
    }
    if (!had) return false;
    this.set(loggedOut ? { status: 'anonymous', loggedOut: true } : { status: 'anonymous' });
    this.gen++;
    this.ended$.next();
    return true;
  }

  get generation(): number {
    return this.gen;
  }

  signIn(result: LoginSuccess): void {
    this.gen++;
    this.restoreRun++;
    this.booting = false;
    this.store.set(result.accessToken);
    this.set({ status: 'authenticated', me: result.user as Me });
  }

  async signOut(to = '/login'): Promise<void> {
    try {
      await this.api.POST('/auth/logout');
    } catch {}
    this.endLocally(true);
    this.channel?.postMessage({ type: 'logout' });
    await this.router.navigateByUrl(to, { replaceUrl: true });
  }

  async reloadMe(generation: number): Promise<boolean> {
    for (const wait of [0, 1000, 2000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (generation !== this.gen) return false;
      try {
        this.setMe(await this.loadMe(), generation);
        return generation === this.gen;
      } catch (e) {
        if (e instanceof ApiProblem && e.status >= 400 && e.status < 500) return false;
      }
    }
    return false;
  }

  setMe(me: Me, generation: number): void {
    if (generation !== this.gen || this.state().status !== 'authenticated') return;
    this.set({ status: 'authenticated', me });
  }
}
