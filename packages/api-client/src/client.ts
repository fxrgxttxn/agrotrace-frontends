import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './schema';
import { ApiProblem } from './problem';
import type { TokenStore } from './session';
import { uuidv4 } from './util';
import { withVariant } from './variant';

export { withVariant };

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

/** R48/R53 helper: a fresh `Idempotency-Key` for a mutating request. */
export function newIdempotencyKey(): string {
  return uuidv4();
}

function newRequestId(): string {
  return uuidv4();
}

function urlPath(url: string): string {
  const separatorIndex = url.indexOf('?');
  return separatorIndex === -1 ? url : url.slice(0, separatorIndex);
}

function endsWithAnyPath(url: string, suffixes: readonly string[]): boolean {
  const path = urlPath(url);
  return suffixes.some((suffix) => path.endsWith(suffix));
}

/** R62: exactly the `/auth/*` operations with `security: []` in the contract
 * (contracts/openapi/paths/auth.yaml) — i.e. the ones that don't require a valid access token in
 * the first place, so a 401 from any of them (wrong password, bad/reused 2FA code, an
 * expired/used password-reset or invite token, …) is a normal application-level response, never
 * evidence that a previously-good *session* has gone stale. Every other `/auth/*` operation
 * (currently only `/auth/2fa/setup`) is bearer-secured and refreshes-and-retries on 401 exactly
 * like any other endpoint. Exported so test/no-refresh-paths.test.ts can assert this list matches
 * the contract's actual `security: []` operations under `/auth/` — keep the two in sync by hand;
 * the test fails loudly if they drift. */
export const NO_REFRESH_AUTH_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/2fa/verify',
  '/auth/password/forgot',
  '/auth/password/reset',
  '/auth/register-organization',
  '/auth/accept-invite',
] as const;

function isNoRefreshAuthPath(url: string): boolean {
  return endsWithAnyPath(url, NO_REFRESH_AUTH_PATHS);
}

/** The only two operations that get `credentials: 'include'` (contracts/openapi/paths/auth.yaml —
 * both set/clear the httpOnly `at_refresh` cookie, path `/api/v1/auth`). Deliberately a *narrower*
 * set than {@link NO_REFRESH_AUTH_PATHS}: e.g. `/auth/login` also has `security: []` but doesn't
 * need `credentials: 'include'` to receive its `Set-Cookie` on a same-origin request. */
const CREDENTIALS_INCLUDE_PATHS = ['/auth/refresh', '/auth/logout'] as const;

function isCredentialsIncludePath(url: string): boolean {
  return endsWithAnyPath(url, CREDENTIALS_INCLUDE_PATHS);
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
  /** Minor B dedupe key: the token `onAuthLost` has already been reported dead for, so concurrent
   * callers discovering the *same* dead token don't each fire it separately. `undefined` means "no
   * report outstanding"; reset back to that by the store subscription below whenever a fresh,
   * non-null token is installed (by us, another tab's broadcast, or a login elsewhere in the app),
   * so a later, genuinely new auth-loss episode can still report. */
  private reportedDeadToken: string | null | undefined = undefined;
  private unsubscribe: () => void;
  /** Bumps on every change of the store (a logout clearing it, a sign-in, another tab's token, our own install): a
   * refresh whose answer arrives in a later generation belongs to a session that ended or was replaced — its token is
   * neither installed nor broadcast. */
  private generation = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly session: TokenStore,
    private readonly fetchImpl: FetchLike,
    private readonly onAuthLost?: () => void,
  ) {
    this.unsubscribe = this.session.subscribe((token) => {
      this.generation += 1;
      if (token !== null) this.reportedDeadToken = undefined;
    });
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

  /** Minor A/B: no-ops (leaving the store and `onAuthLost` alone) if the store has already moved
   * past `deadToken` — some other tab or request has since installed something newer, so this
   * particular 401 is stale information, not grounds to log out — or if `onAuthLost` has already
   * fired for this exact token. Otherwise clears the store and reports it, once. */
  reportAuthLoss(deadToken: string | null): void {
    if (this.session.get() !== deadToken) return;
    if (this.reportedDeadToken === deadToken) return;
    this.reportedDeadToken = deadToken;
    this.session.set(null);
    this.onAuthLost?.();
  }

  private runSingleFlight(tokenAtFailure: string | null, usedLock: boolean): Promise<string | null> {
    if (!this.inFlight) {
      const attempt = this.doRefresh(tokenAtFailure, usedLock);
      this.inFlight = attempt;
      attempt.then(
        () => {
          if (this.inFlight === attempt) this.inFlight = null;
        },
        () => {
          // Minor D: on a *transient* failure (network error / 5xx — normal under R61, e.g. during
          // a backend restart), keep this rejected attempt briefly cached rather than clearing it
          // immediately, so every caller already queued behind the same Web Lock at the moment of
          // the outage shares this one rejection instead of each making its own network call in
          // turn as the lock hands off to them one by one. A macrotask is long enough for a mock
          // (or real) lock's already-queued callbacks to drain — since those are chained via
          // microtasks internally — but short enough that a genuinely later, new 401 still gets a
          // fresh attempt rather than being permanently stuck on a stale failure.
          setTimeout(() => {
            if (this.inFlight === attempt) this.inFlight = null;
          }, 0);
        },
      );
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
    const generation = this.generation;

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
      let body: { accessToken?: unknown };
      try {
        body = (await response.json()) as { accessToken?: unknown };
      } catch (error) {
        throw ApiProblem.transient('Malformed response from /auth/refresh', response.status, error);
      }
      // Minor C: a 200 with no usable accessToken is just as malformed as unparsable JSON — never
      // install/broadcast a non-string (or empty) token.
      if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
        throw ApiProblem.transient('Malformed response from /auth/refresh (no accessToken)', response.status);
      }
      const accessToken = body.accessToken;
      // The session ended (a logout here or in another tab cleared the store) or another token was installed meanwhile
      // (a sign-in, another tab's rotation): this answer is stale — never install or broadcast it.
      if (this.generation !== generation) return this.session.get();
      this.session.set(accessToken);
      this.channel?.postMessage({ token: accessToken });
      return accessToken;
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
      this.reportAuthLoss(tokenAtFailure);
      return this.session.get();
    }

    // Any other status (5xx, an unexpected 4xx): transient per R61 — only 401/403 end the session.
    throw ApiProblem.transient('Unexpected response from /auth/refresh', response.status);
  }

  close(): void {
    this.unsubscribe();
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
 * `/auth/logout`, single-flight refresh-and-retry on 401 (never for the `security: []` `/auth/*`
 * operations — R62 — and never for a request that carried no Authorization header to begin with),
 * and automatic retry of 409 IDEMPOTENCY_KEY_IN_PROGRESS responses. */
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
    const skipRefresh = isNoRefreshAuthPath(url);
    const withCredentials = isCredentialsIncludePath(url);

    const send = async (): Promise<{ response: Response; tokenUsed: string | null }> => {
      const headers = new Headers(baseRequest.headers);
      const token = opts.session.get();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      headers.set('X-Request-Id', newRequestId());
      const attempt = new Request(baseRequest.clone(), {
        headers,
        credentials: withCredentials ? 'include' : baseRequest.credentials,
      });
      const response = await baseFetch(attempt);
      return { response, tokenUsed: token };
    };

    let { response, tokenUsed } = await send();
    let refreshed = false;
    let idempotencyAttempts = 0;

    for (;;) {
      // R62: never for a `security: []` /auth/* operation (a wrong password or bad 2FA code is
      // not a stale session — but a bearer-secured one like /auth/2fa/setup refreshes normally),
      // and never for a request that was sent with no Authorization header at all (nothing to
      // refresh).
      if (response.status === 401 && !skipRefresh && tokenUsed !== null) {
        if (!refreshed) {
          refreshed = true;
          const newToken = await coordinator.refresh(tokenUsed);
          if (!newToken) return response;
          ({ response, tokenUsed } = await send());
          continue;
        }
        // Brief gap: the retry with a freshly-refreshed token still got 401 — that token is no
        // good either (Minors A/B: reportAuthLoss no-ops if the store has already moved past
        // `tokenUsed`, and dedupes so concurrent requests discovering the same dead token don't
        // each fire onAuthLost separately).
        coordinator.reportAuthLoss(tokenUsed);
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
