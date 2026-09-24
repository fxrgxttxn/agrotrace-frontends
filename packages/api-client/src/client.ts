import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './schema';
import type { TokenStore } from './session';

type FetchLike = typeof fetch;

/** `createApi`'s return type: a fully typed openapi-fetch client, plus `refresh()` so callers that
 * need to share the same single-flight refresh (e.g. {@link openEventStream} on `reauth`, R33) can
 * trigger it explicitly instead of duplicating the refresh protocol. */
export type Api = Client<paths> & {
  /** Runs (or joins) the single-flight token refresh and returns the new access token, or `null`
   * if the refresh failed (in which case `onAuthLost` has already fired and the store is cleared). */
  refresh(): Promise<string | null>;
};

const REFRESH_LOCK_NAME = 'agrotrace-refresh';
const AUTH_BROADCAST_CHANNEL = 'agrotrace-auth';
/** How long to wait for another tab's broadcast token after our own refresh call gets a 401
 * TOKEN_EXPIRED, before treating it as a genuine auth loss (R32's 10 s rotation-reuse grace window). */
const REFRESH_GRACE_WINDOW_MS = 10_000;
/** R48/R53: retry a request that hit 409 IDEMPOTENCY_KEY_IN_PROGRESS up to this many times. */
const IDEMPOTENCY_MAX_RETRIES = 5;

/** R48/R53 helper: a fresh `Idempotency-Key` for a mutating request. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** R28/R39 helper: sets (or replaces) the `variant` query param of a signed or public file URL
 * without touching any other param (`exp`/`sig` are never re-derived client-side). */
export function withVariant(url: string, variant: '96' | '480'): string {
  const separatorIndex = url.indexOf('?');
  const path = separatorIndex === -1 ? url : url.slice(0, separatorIndex);
  const query = separatorIndex === -1 ? '' : url.slice(separatorIndex + 1);
  const params = new URLSearchParams(query);
  params.set('variant', variant);
  return `${path}?${params.toString()}`;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

function urlPath(url: string): string {
  const separatorIndex = url.indexOf('?');
  return separatorIndex === -1 ? url : url.slice(0, separatorIndex);
}

function isPath(url: string, suffix: string): boolean {
  return urlPath(url).endsWith(suffix);
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

/** Serializes the R32 refresh protocol: single-flight (in-memory, and across tabs via Web Locks
 * when available), re-checking the store before hitting the network, and — on a 401 TOKEN_EXPIRED
 * from the refresh call itself — waiting briefly for another tab's BroadcastChannel token before
 * giving up. */
class RefreshCoordinator {
  private inFlight: Promise<string | null> | null = null;
  private channel: BroadcastChannel | null = null;
  /** Resolvers waiting on the *next* broadcast token (used only for the R32 grace window below —
   * the permanent listener above always updates the store regardless of whether anyone is waiting). */
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

  /** `tokenAtFailure` is the token that was current when the caller observed the 401 — used to
   * detect that another tab (or the permanent broadcast listener above) already refreshed by the
   * time we get to run. */
  refresh(tokenAtFailure: string | null): Promise<string | null> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(REFRESH_LOCK_NAME, () => this.runSingleFlight(tokenAtFailure));
    }
    return this.runSingleFlight(tokenAtFailure);
  }

  private runSingleFlight(tokenAtFailure: string | null): Promise<string | null> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh(tokenAtFailure).finally(() => {
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

  private async doRefresh(tokenAtFailure: string | null): Promise<string | null> {
    // Another tab's broadcast (relayed to our store by the permanent listener above), or a
    // previous same-tab waiter once the lock is released, may already have refreshed — never call
    // the network if the store has already moved on.
    const current = this.session.get();
    if (current !== tokenAtFailure) {
      return current;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Request-Id': newRequestId() },
      });
    } catch {
      this.session.set(null);
      this.onAuthLost?.();
      return null;
    }

    if (response.ok) {
      const body = (await response.json()) as { accessToken: string };
      this.session.set(body.accessToken);
      this.channel?.postMessage({ token: body.accessToken });
      return body.accessToken;
    }

    if (response.status === 401) {
      // R32: a 401 TOKEN_EXPIRED here can mean another tab's rotation won the race within the
      // server's 10 s grace window — wait for its broadcast token instead of logging out.
      const wonElsewhere = await this.waitForBroadcastToken(REFRESH_GRACE_WINDOW_MS);
      if (wonElsewhere) {
        this.session.set(wonElsewhere);
        return wonElsewhere;
      }
    }

    this.session.set(null);
    this.onAuthLost?.();
    return null;
  }

  close(): void {
    this.channel?.close();
  }
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

export interface CreateApiOptions {
  /** Default `/api/v1`, matching `servers` in contracts/openapi.yaml. */
  baseUrl?: string;
  session: TokenStore;
  /** Called once the refresh call itself has failed for good (not the race/grace-window case) —
   * the store has already been cleared by the time this fires. */
  onAuthLost?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Builds the typed openapi-fetch client with the shared middleware behaviour: Bearer injection,
 * a unique `X-Request-Id` per request, `credentials: 'include'` only for `/auth/refresh` and
 * `/auth/logout`, single-flight refresh-and-retry on 401, and automatic retry of
 * 409 IDEMPOTENCY_KEY_IN_PROGRESS responses. */
export function createApi(opts: CreateApiOptions): Api {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const baseFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const coordinator = new RefreshCoordinator(baseUrl, opts.session, baseFetch, opts.onAuthLost);

  const clientFetch: FetchLike = async (input, init) => {
    // openapi-fetch always hands us a fully-built `Request` (headers, body, method already set)
    // with `init` left undefined — normalizing here also covers a plain string/URL + init caller.
    // Kept pristine (never itself passed to `fetch`, only cloned) so every attempt below can reuse
    // its body, however many retries this call ends up taking.
    const baseRequest = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = baseRequest.url;
    const isAuthEndpoint = isPath(url, '/auth/refresh') || isPath(url, '/auth/logout');

    const send = (): Promise<Response> => {
      const headers = new Headers(baseRequest.headers);
      const token = opts.session.get();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      headers.set('X-Request-Id', newRequestId());
      const attempt = new Request(baseRequest.clone(), {
        headers,
        credentials: isAuthEndpoint ? 'include' : baseRequest.credentials,
      });
      return baseFetch(attempt);
    };

    let response = await send();
    let refreshed = false;
    let idempotencyAttempts = 0;

    for (;;) {
      if (response.status === 401 && !isAuthEndpoint && !refreshed) {
        refreshed = true;
        const tokenAtFailure = opts.session.get();
        const newToken = await coordinator.refresh(tokenAtFailure);
        if (!newToken) return response;
        response = await send();
        continue;
      }

      if (response.status === 409 && idempotencyAttempts < IDEMPOTENCY_MAX_RETRIES) {
        const code = await readProblemCode(response);
        if (code === 'IDEMPOTENCY_KEY_IN_PROGRESS') {
          idempotencyAttempts += 1;
          await sleep(retryAfterMs(response));
          response = await send();
          continue;
        }
      }

      return response;
    }
  };

  const client = createClient<paths>({ baseUrl, fetch: clientFetch }) as Api;
  client.refresh = () => coordinator.refresh(opts.session.get());
  return client;
}
