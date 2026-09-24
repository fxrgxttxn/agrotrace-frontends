import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './schema';
import { ApiProblem } from './problem';
import type { TokenStore } from './session';

type FetchLike = typeof fetch;

/** `createApi`'s return type: a fully typed openapi-fetch client, plus `refresh()` so callers that
 * need to share the same single-flight refresh (e.g. {@link openEventStream} on `reauth`, R33) can
 * trigger it explicitly instead of duplicating the refresh protocol, and `dispose()` to release the
 * BroadcastChannel this client opened. */
export type Api = Client<paths> & {
  /** Runs (or joins) the single-flight token refresh and returns the new access token, or `null`
   * if the refresh failed for good (in which case `onAuthLost` has already fired and the store is
   * cleared). Rejects instead, without touching the store, for a transient failure (R61) —
   * network error, or a non-401/403 response from `/auth/refresh`. */
  refresh(): Promise<string | null>;
  /** Closes this client's BroadcastChannel. Only needed for long-running apps that create and tear
   * down clients repeatedly (e.g. hot-reload); a page that keeps one client for its lifetime can
   * ignore this. */
  dispose(): void;
};

const REFRESH_LOCK_NAME = 'agrotrace-refresh';
const AUTH_BROADCAST_CHANNEL = 'agrotrace-auth';
/** How long to wait for another tab's broadcast token after our own refresh call gets a 401
 * TOKEN_EXPIRED, before treating it as a genuine auth loss (R32's 10 s rotation-reuse grace window).
 * Skipped entirely in the cases where no same-browser rotation could possibly be racing us — see
 * `doRefresh`. */
const REFRESH_GRACE_WINDOW_MS = 10_000;
/** R48/R53: retry a request that hit 409 IDEMPOTENCY_KEY_IN_PROGRESS up to this many times. */
const IDEMPOTENCY_MAX_RETRIES = 5;

/** RFC 4122 v4 UUID, preferring `crypto.randomUUID()` but falling back to `crypto.getRandomValues`
 * for environments/older browsers that only have the latter (R61). */
function uuidv4(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('No secure random source available: crypto.getRandomValues is required');
  }
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** R48/R53 helper: a fresh `Idempotency-Key` for a mutating request. */
export function newIdempotencyKey(): string {
  return uuidv4();
}

/** R28/R39 helper: sets (or replaces) the `variant` query param of a signed or public file URL
 * without touching any other param (`exp`/`sig` are never re-derived client-side). The type is the
 * contract's own `ImageVariant` parameter (`96 | 480`, contracts/openapi/components/parameters.yaml). */
export function withVariant(url: string, variant: components['parameters']['ImageVariant']): string {
  const separatorIndex = url.indexOf('?');
  const path = separatorIndex === -1 ? url : url.slice(0, separatorIndex);
  const query = separatorIndex === -1 ? '' : url.slice(separatorIndex + 1);
  const params = new URLSearchParams(query);
  params.set('variant', String(variant));
  return `${path}?${params.toString()}`;
}

function newRequestId(): string {
  return uuidv4();
}

function urlPath(url: string): string {
  const separatorIndex = url.indexOf('?');
  return separatorIndex === -1 ? url : url.slice(0, separatorIndex);
}

/** Any `/auth/*` operation (login, refresh, logout, 2FA, password reset, invites, registration —
 * contracts/openapi/paths/auth.yaml) — Critical fix: a 401 from *any* of these (wrong password,
 * bad 2FA code, …) must never trigger our refresh-and-retry or `onAuthLost` protocol, which is only
 * about a previously-valid *session* going stale. */
function isAuthPath(url: string): boolean {
  return /\/auth\//.test(urlPath(url));
}

async function readProblemCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { code?: string };
    return body?.code;
  } catch {
    return undefined;
  }
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('Retry-After');
  const seconds = header === null ? 1 : Number(header);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

/** Serializes the R32 refresh protocol: single-flight (in-memory, and across tabs via Web Locks
 * when available), re-checking the store before hitting the network, and — on a 401 TOKEN_EXPIRED
 * from the refresh call itself — waiting briefly for another tab's BroadcastChannel token before
 * giving up. R61: only a 401 or 403 from `/auth/refresh` itself ends the session; every other
 * failure (network error, 5xx, malformed body) is transient and rejects without touching the store. */
class RefreshCoordinator {
  private inFlight: Promise<string | null> | null = null;
  private channel: BroadcastChannel | null = null;
  /** Resolvers waiting on the *next* broadcast token (used only for the grace window below — the
   * permanent listener above always updates the store regardless of whether anyone is waiting). */
  private waiters: Array<(token: string) => void> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly session: TokenStore,
    private readonly fetchImpl: FetchLike,
    private readonly onAuthLost?: () => void,
  ) {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
        // Real tabs never share a TokenStore instance — this listener is the *only* way another
        // tab's rotation reaches ours, so it must update the store as soon as any tab refreshes,
        // not only while someone happens to be waiting in the grace window below.
        this.channel.addEventListener('message', (event: MessageEvent) => {
          const token = (event.data as { token?: string | null } | undefined)?.token;
          if (!token) return;
          this.session.set(token);
          const waiters = this.waiters;
          this.waiters = [];
          for (const resolve of waiters) resolve(token);
        });
      }
    } catch {
      this.channel = null;
    }
  }

  /** `tokenAtFailure` must be the token that was actually sent on the request that got the 401 —
   * not whatever `session.get()` happens to return when this is called (Important fix: those can
   * differ if another request's refresh already landed in between). */
  refresh(tokenAtFailure: string | null): Promise<string | null> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(REFRESH_LOCK_NAME, () => this.runSingleFlight(tokenAtFailure, true));
    }
    return this.runSingleFlight(tokenAtFailure, false);
  }

  private runSingleFlight(tokenAtFailure: string | null, usedLock: boolean): Promise<string | null> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh(tokenAtFailure, usedLock).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private waitForBroadcastToken(timeoutMs: number): Promise<string | null> {
    if (!this.channel) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (token: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.waiters.indexOf(finish as (token: string) => void);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(token);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.waiters.push(finish);
    });
  }

  private async doRefresh(tokenAtFailure: string | null, usedLock: boolean): Promise<string | null> {
    // Another tab's broadcast (relayed to our store by the permanent listener above), or a
    // previous same-tab waiter once the lock is released, may already have refreshed — never call
    // the network if the store has already moved on.
    const before = this.session.get();
    if (before !== tokenAtFailure) {
      return before;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Request-Id': newRequestId() },
      });
    } catch (error) {
      // R61: a network error while refreshing is transient — the session may still be perfectly
      // valid, we just couldn't reach the server this time. Never log out for this.
      throw ApiProblem.transient('Network error while refreshing the access token', 0, error);
    }

    if (response.ok) {
      let body: { accessToken: string };
      try {
        body = (await response.json()) as { accessToken: string };
      } catch (error) {
        throw ApiProblem.transient('Malformed response from /auth/refresh', response.status, error);
      }
      this.session.set(body.accessToken);
      this.channel?.postMessage({ token: body.accessToken });
      return body.accessToken;
    }

    if (response.status === 401) {
      // Important fix: the permanent broadcast listener above may already have applied another
      // tab's rotation while our own network call was in flight — check before waiting for a NEW
      // message that may never arrive.
      const afterOwnCall = this.session.get();
      if (afterOwnCall !== tokenAtFailure) {
        return afterOwnCall;
      }

      // Skip the grace wait when it cannot possibly help: with Web Locks, no other same-browser
      // tab could be concurrently rotating right now (we hold the exclusive lock, so a 401 here
      // is not "another tab won the race" — R32's race requires two *concurrent* callers); and
      // with no token at all there was never a session to race over in the first place (e.g. an
      // app boot trying to silently restore a session from the refresh cookie).
      if (!usedLock && tokenAtFailure !== null) {
        const wonElsewhere = await this.waitForBroadcastToken(REFRESH_GRACE_WINDOW_MS);
        if (wonElsewhere) {
          this.session.set(wonElsewhere);
          return wonElsewhere;
        }
      }
    }

    if (response.status === 401 || response.status === 403) {
      // Never clobber a token some other tab installed while we were waiting or calling out —
      // only null out the token we actually know is dead.
      const current = this.session.get();
      if (current !== tokenAtFailure) {
        return current;
      }
      this.session.set(null);
      this.onAuthLost?.();
      return null;
    }

    // Any other status (5xx, an unexpected 4xx): transient per R61 — only 401/403 end the session.
    throw ApiProblem.transient('Unexpected response from /auth/refresh', response.status);
  }

  close(): void {
    this.channel?.close();
  }
}

export interface CreateApiOptions {
  /** Default `/api/v1`, matching `servers` in contracts/openapi.yaml. */
  baseUrl?: string;
  session: TokenStore;
  /** Called once the refresh call itself has failed for good (401/403, not the race/grace-window
   * case, and not a transient failure per R61) — the store has already been cleared by the time
   * this fires. Also called when a request retried with a freshly-refreshed token still gets a
   * second 401 (that token is no good either). */
  onAuthLost?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Builds the typed openapi-fetch client with the shared middleware behaviour: Bearer injection,
 * a unique `X-Request-Id` per request, `credentials: 'include'` only for `/auth/refresh` and
 * `/auth/logout`, single-flight refresh-and-retry on 401 (never for `/auth/*` itself, and never for
 * a request that carried no Authorization header to begin with), and automatic retry of
 * 409 IDEMPOTENCY_KEY_IN_PROGRESS responses. */
export function createApi(opts: CreateApiOptions): Api {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const baseFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const coordinator = new RefreshCoordinator(baseUrl, opts.session, baseFetch, opts.onAuthLost);

  const clientFetch: FetchLike = async (input, init) => {
    // openapi-fetch always hands us a fully-built `Request` (headers, body, method already set)
    // with `init` left undefined — normalizing here also covers a plain string/URL + init caller.
    // Kept pristine (never itself passed to `fetch`, only cloned) so every attempt below can reuse
    // its body (and any Idempotency-Key/If-Match header), however many retries this takes.
    const baseRequest = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = baseRequest.url;
    const isAuthEndpoint = isAuthPath(url);

    const send = async (): Promise<{ response: Response; tokenUsed: string | null }> => {
      const headers = new Headers(baseRequest.headers);
      const token = opts.session.get();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      headers.set('X-Request-Id', newRequestId());
      const attempt = new Request(baseRequest.clone(), {
        headers,
        credentials: isAuthEndpoint ? 'include' : baseRequest.credentials,
      });
      const response = await baseFetch(attempt);
      return { response, tokenUsed: token };
    };

    let { response, tokenUsed } = await send();
    let refreshed = false;
    let idempotencyAttempts = 0;

    for (;;) {
      // Never for /auth/* (Critical fix — a wrong password or bad 2FA code is not a stale
      // session), and never for a request that was sent with no Authorization header at all
      // (nothing to refresh).
      if (response.status === 401 && !isAuthEndpoint && tokenUsed !== null) {
        if (!refreshed) {
          refreshed = true;
          const newToken = await coordinator.refresh(tokenUsed);
          if (!newToken) return response;
          ({ response, tokenUsed } = await send());
          continue;
        }
        // Brief gap: the retry with a freshly-refreshed token still got 401 — that token is no
        // good either.
        opts.session.set(null);
        opts.onAuthLost?.();
        return response;
      }

      if (response.status === 409 && idempotencyAttempts < IDEMPOTENCY_MAX_RETRIES) {
        const code = await readProblemCode(response);
        if (code === 'IDEMPOTENCY_KEY_IN_PROGRESS') {
          idempotencyAttempts += 1;
          await sleep(retryAfterMs(response));
          ({ response, tokenUsed } = await send());
          continue;
        }
      }

      return response;
    }
  };

  const client = createClient<paths>({ baseUrl, fetch: clientFetch }) as Api;
  client.refresh = () => coordinator.refresh(opts.session.get());
  client.dispose = () => coordinator.close();
  return client;
}
