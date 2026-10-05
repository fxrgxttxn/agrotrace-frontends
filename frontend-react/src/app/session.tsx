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
import { cacheGeneration, resetSessionCache, setSessionActive } from './cache';
import { trackRequest } from './actions';
import { useToast } from '../ui/Toasts';

const REFRESH_429_WAIT = 10;

export const API_BASE = '/api/v1';
const SESSION_CHANNEL = 'agrotrace-session';

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
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      trackRequest(() => (fetchImpl ?? globalThis.fetch)(input, init)),
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
  signIn: (result: LoginSuccess) => void;
  signOut: (to?: string) => Promise<void>;
  reloadMe: () => Promise<void>;
  setMe: (me: Me) => void;
  restore: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside <SessionProvider>');
  return s;
}

export function useMe(): Me {
  const { state } = useSession();
  if (state.status !== 'authenticated') throw new Error('useMe without a session');
  return state.me;
}

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

  const authed = useRef(false);
  const becomeAuthenticated = useCallback(
    (me: Me) => {
      authed.current = true;
      setSessionActive(queryClient, true);
      dispatch({ type: 'authenticated', me });
    },
    [queryClient],
  );

  const restoreRun = useRef(0);
  const restore = useCallback(async () => {
    const run = ++restoreRun.current;
    const current = () => restoreRun.current === run;
    booting.current = true;
    dispatch({ type: 'loading' });
    try {
      const token = store.get() ?? (await api.refresh());
      if (!current()) return;
      if (!token) {
        dispatch({ type: 'anonymous' });
        return;
      }
      const me = await loadMe();
      if (!current()) return;
      becomeAuthenticated(me);
    } catch (e) {
      if (!current()) return;
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
      if (current()) booting.current = false;
    }
  }, [api, store, loadMe, becomeAuthenticated]);

  const toLogin = useCallback(() => {
    const next = safeNext(here.current);
    navigate(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [navigate]);

  const channel = useRef<BroadcastChannel | null>(null);

  const endLocally = useCallback(
    (loggedOut = false) => {
      store.set(null);
      if (authed.current) resetSessionCache(queryClient);
      authed.current = false;
      setSessionActive(queryClient, false);
      dispatch({ type: 'anonymous', loggedOut });
    },
    [store, queryClient],
  );

  useEffect(() => {
    core.onAuthLost.current = () => {
      if (booting.current) return;
      if (!authed.current) {
        store.set(null);
        return;
      }
      endLocally();
      toast.push({ tone: 'attention', text: t('errors.TOKEN_EXPIRED') });
      toLogin();
    };
    return () => {
      core.onAuthLost.current = () => {};
    };
  }, [core, endLocally, toLogin, toast, store]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SESSION_CHANNEL);
    channel.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'logout') {
        if (!authed.current) {
          store.set(null);
          if (booting.current) {
            restoreRun.current++;
            booting.current = false;
            dispatch({ type: 'anonymous' });
          }
          return;
        }
        endLocally(true);
        navigate('/login', { replace: true });
      }
    };
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [endLocally, navigate, store]);

  useEffect(() => {
    void restore();
  }, [restore]);

  const signIn = useCallback(
    (result: LoginSuccess) => {
      resetSessionCache(queryClient);
      restoreRun.current++;
      booting.current = false;
      store.set(result.accessToken);
      becomeAuthenticated(result.user as Me);
    },
    [store, queryClient, becomeAuthenticated],
  );

  const signOut = useCallback(
    async (to = '/login') => {
      try {
        await api.POST('/auth/logout');
      } catch {}
      endLocally(true);
      channel.current?.postMessage({ type: 'logout' });
      navigate(to, { replace: true });
    },
    [api, endLocally, navigate],
  );

  const reloadMe = useCallback(async () => {
    const gen = cacheGeneration(queryClient);
    const me = await loadMe();
    if (!authed.current || cacheGeneration(queryClient) !== gen) return;
    dispatch({ type: 'authenticated', me });
  }, [loadMe, queryClient]);

  const setMe = useCallback((me: Me) => {
    if (!authed.current) return;
    dispatch({ type: 'authenticated', me });
  }, []);

  const value = useMemo<Session>(
    () => ({ state, api, store, signIn, signOut, reloadMe, setMe, restore }),
    [state, api, store, signIn, signOut, reloadMe, setMe, restore],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
