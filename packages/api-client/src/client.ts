import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './schema';
import { ApiProblem } from './problem';
import type { TokenStore } from './session';
import { uuidv4 } from './util';
import { withVariant } from './variant';

export { withVariant };

type FetchLike = typeof fetch;

export type Api = Client<paths> & {
  refresh(): Promise<string | null>;
  dispose(): void;
};

const REFRESH_LOCK_NAME = 'agrotrace-refresh';
const AUTH_BROADCAST_CHANNEL = 'agrotrace-auth';
const REFRESH_GRACE_WINDOW_MS = 10_000;
const IDEMPOTENCY_MAX_RETRIES = 5;

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

class RefreshCoordinator {
  private inFlight: Promise<string | null> | null = null;
  private channel: BroadcastChannel | null = null;
  private waiters: Array<(token: string) => void> = [];
  private reportedDeadToken: string | null | undefined = undefined;
  private unsubscribe: () => void;
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

  refresh(tokenAtFailure: string | null): Promise<string | null> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(REFRESH_LOCK_NAME, () => this.runSingleFlight(tokenAtFailure, true));
    }
    return this.runSingleFlight(tokenAtFailure, false);
  }

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
      throw ApiProblem.transient('Network error while refreshing the access token', 0, error);
    }

    if (response.ok) {
      let body: { accessToken?: unknown };
      try {
        body = (await response.json()) as { accessToken?: unknown };
      } catch (error) {
        throw ApiProblem.transient('Malformed response from /auth/refresh', response.status, error);
      }
      if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
        throw ApiProblem.transient('Malformed response from /auth/refresh (no accessToken)', response.status);
      }
      const accessToken = body.accessToken;
      if (this.generation !== generation) return this.session.get();
      this.session.set(accessToken);
      this.channel?.postMessage({ token: accessToken });
      return accessToken;
    }

    if (response.status === 401) {
      const afterOwnCall = this.session.get();
      if (afterOwnCall !== tokenAtFailure) {
        return afterOwnCall;
      }

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

    throw ApiProblem.transient('Unexpected response from /auth/refresh', response.status);
  }

  close(): void {
    this.unsubscribe();
    this.channel?.close();
  }
}

export interface CreateApiOptions {
  baseUrl?: string;
  session: TokenStore;
  onAuthLost?: () => void;
  fetch?: FetchLike;
}

export function createApi(opts: CreateApiOptions): Api {
  const baseUrl = opts.baseUrl ?? '/api/v1';
  const baseFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const coordinator = new RefreshCoordinator(baseUrl, opts.session, baseFetch, opts.onAuthLost);

  const clientFetch: FetchLike = async (input, init) => {
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
      if (response.status === 401 && !skipRefresh && tokenUsed !== null) {
        if (!refreshed) {
          refreshed = true;
          const newToken = await coordinator.refresh(tokenUsed);
          if (!newToken) return response;
          ({ response, tokenUsed } = await send());
          continue;
        }
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
