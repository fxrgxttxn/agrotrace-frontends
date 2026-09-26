import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
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
import { resetSessionCache } from './cache';
import { useToast } from '../ui/Toasts';

// Session (spec §9.2 «Context + useReducer», rulings R32/R61/R62): the access token lives in memory only
// (createMemoryTokenStore); the refresh token is the httpOnly `at_refresh` cookie. At start the app restores the
// session from the cookie (`POST /auth/refresh`, serialized across tabs by api-client's Web Lock) and loads `/me`.
// A session lost for good (refresh 401/403) sends the user to `/login?next=<where they were>`; a transient failure
// (network, 5xx) never logs out (R61). Logout is broadcast to the other tabs.

/** Wait after a 429 of `/auth/refresh`: api-client reports it as a transient problem without its Retry-After. */
const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
const SESSION_CHANNEL = 'agrotrace-session';

/** Absolute API base: `Request` outside a browser page (tests) needs an absolute URL. */
export function apiBaseUrl(): string {
  return `${location.origin}${API_BASE}`;
}

export interface SessionCore {
  store: TokenStore;
  api: Api;
  /** Replaced by the provider: what to do when the session is lost for good. */
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

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; loggedOut?: boolean }
  | { status: 'unavailable'; retryAfter?: number }
  | { status: 'authenticated'; me: Me };

type Action =
  | { type: 'loading' }
  | { type: 'anonymous'; loggedOut?: boolean }
  | { type: 'unavailable'; retryAfter?: number }
  | { type: 'authenticated'; me: Me };

function reducer(_: SessionState, action: Action): SessionState {
  if (action.type === 'authenticated') return { status: 'authenticated', me: action.me };
  if (action.type === 'unavailable')
    return action.retryAfter
      ? { status: 'unavailable', retryAfter: action.retryAfter }
      : { status: 'unavailable' };
  if (action.type === 'anonymous')
    return action.loggedOut ? { status: 'anonymous', loggedOut: true } : { status: 'anonymous' };
  return { status: action.type };
}

export interface Session {
  state: SessionState;
  api: Api;
  store: TokenStore;
  /** Installs a successful login (`POST /auth/login` or `/auth/2fa/verify`). */
  signIn: (result: LoginSuccess) => void;
  /** `POST /auth/logout`, clears the session here and in the other tabs, then goes to `to` (default `/login`). */
  signOut: (to?: string) => Promise<void>;
  /** Reloads `/me` (after a profile change). */
  reloadMe: () => Promise<void>;
  /** Installs a profile the API just returned (`PATCH /me`). */
  setMe: (me: Me) => void;
  /** Retries the start-up restore after a transient failure. */
  restore: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside <SessionProvider>');
  return s;
}

/** The signed-in user; only for components rendered behind the auth guard. */
export function useMe(): Me {
  const { state } = useSession();
  if (state.status !== 'authenticated') throw new Error('useMe without a session');
  return state.me;
}

/** A `next` target is only ever a same-origin path (no open redirect), never an auth screen. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login/') || raw.startsWith('/login?')) return '/';
  return raw;
}

export function SessionProvider({ core, children }: { core: SessionCore; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { status: 'loading' });
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const booting = useRef(true);
  const here = useRef('/');
  here.current = `${location.pathname}${location.search}`;
  const { api, store } = core;

  const loadMe = useCallback(() => call<Me>(api.GET('/me')), [api]);

  const restore = useCallback(async () => {
    booting.current = true;
    dispatch({ type: 'loading' });
    try {
      const token = store.get() ?? (await api.refresh());
      if (!token) {
        dispatch({ type: 'anonymous' });
        return;
      }
      dispatch({ type: 'authenticated', me: await loadMe() });
    } catch (e) {
      // R61: a network error, a 5xx or a rate limit (429 of /auth/refresh or /me) is not a logout — the session is kept
      // and a retry is offered (after Retry-After for a 429) instead of the login screen.
      if (e instanceof ApiProblem && e.status === 429)
        dispatch({
          type: 'unavailable',
          retryAfter: e.code === 'RATE_LIMITED' ? retryAfterOf(e) : REFRESH_429_WAIT,
        });
      else if (e instanceof ApiProblem && (e.status === 0 || e.status >= 500))
        dispatch({ type: 'unavailable' });
      else if (e instanceof TypeError) dispatch({ type: 'unavailable' });
      else {
        store.set(null);
        dispatch({ type: 'anonymous' });
      }
    } finally {
      booting.current = false;
    }
  }, [api, store, loadMe]);

  const toLogin = useCallback(() => {
    const next = safeNext(here.current);
    navigate(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [navigate]);

  const channel = useRef<BroadcastChannel | null>(null);

  // `loggedOut`: an explicit logout (here or in another tab) goes to a plain /login — no `next` back into the cabinet.
  const endLocally = useCallback(
    (loggedOut = false) => {
      store.set(null);
      resetSessionCache(queryClient);
      dispatch({ type: 'anonymous', loggedOut });
    },
    [store, queryClient],
  );

  useEffect(() => {
    core.onAuthLost.current = () => {
      if (booting.current) return; // start-up without a cookie is simply «not signed in»
      endLocally();
      toast.push({ tone: 'attention', text: t('errors.TOKEN_EXPIRED') });
      toLogin();
    };
    return () => {
      core.onAuthLost.current = () => {};
    };
  }, [core, endLocally, toLogin, toast]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SESSION_CHANNEL);
    channel.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'logout') {
        endLocally(true);
        navigate('/login', { replace: true });
      }
    };
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [endLocally, navigate]);

  useEffect(() => {
    void restore();
  }, [restore]);

  const signIn = useCallback(
    (result: LoginSuccess) => {
      // A new session starts on an empty cache (FM24: nothing of a previous person, their late writes dropped).
      resetSessionCache(queryClient);
      store.set(result.accessToken);
      dispatch({ type: 'authenticated', me: result.user as Me });
    },
    [store, queryClient],
  );

  const signOut = useCallback(
    async (to = '/login') => {
      try {
        await api.POST('/auth/logout');
      } catch {
        // Even when the server is unreachable the local session ends; the cookie expires on its own.
      }
      endLocally(true);
      channel.current?.postMessage({ type: 'logout' });
      navigate(to, { replace: true });
    },
    [api, endLocally, navigate],
  );

  const reloadMe = useCallback(async () => {
    dispatch({ type: 'authenticated', me: await loadMe() });
  }, [loadMe]);

  const setMe = useCallback((me: Me) => dispatch({ type: 'authenticated', me }), []);

  const value = useMemo<Session>(
    () => ({ state, api, store, signIn, signOut, reloadMe, setMe, restore }),
    [state, api, store, signIn, signOut, reloadMe, setMe, restore],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
