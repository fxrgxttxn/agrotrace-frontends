/**
 * Dispatch of `/api/v1/*` requests in the contract's check order (info.description): unknown path → 404, undeclared
 * method → 405 with `Allow`; 401 → `user` rate limit → 403 by role (`x-roles`, `x-org-admin`) → `Idempotency-Key`
 * (`x-idempotent`, R48) → the operation's own checks (body, 404, side, If-Match, transition, references, rules).
 * Requests are processed one at a time (the store is not concurrent); every operation runs as one transaction of the
 * store (rolled back on any error) followed by its after-commit work.
 */
import { idempotencyDecision } from '@agrotrace/domain';
import { OPERATIONS } from '../contract/operations.generated.js';
import type { OperationMeta } from '../contract/types.js';
import { hitRateLimit } from '../domain/limits.js';
import { verifyAccessToken } from '../domain/tokens.js';
import { randomUuid, sha256hex } from '../lib/crypto.js';
import type { Mock } from '../runtime.js';
import type { Principal } from '../store/types.js';
import { json, makeCtx, problemResponse, type Handler } from './context.js';
import { ApiError } from './problem.js';

const PREFIX = '/api/v1';
const IDEMPOTENCY_TTL_SEC = 86_400;
const IDEMPOTENCY_PENDING_TTL_SEC = 60;

interface IdemEntry {
  fingerprint: string;
  state: 'pending' | 'done';
  status?: number;
  body?: unknown;
}

interface Route {
  op: OperationMeta;
  re: RegExp;
  names: string[];
}

const ROUTES: Route[] = OPERATIONS.map((op) => {
  const names: string[] = [];
  const re = new RegExp(
    `^${op.path
      .split('/')
      .map((s) => {
        const m = /^\{([^}]+)\}$/.exec(s);
        if (!m) return s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
        names.push(m[1]!);
        return '([^/]+)';
      })
      .join('/')}$`,
  );
  return { op, re, names };
});

export interface RouterHooks {
  /** Runs before every request (the shared state read through, the schedulers catching up with the clock). */
  beforeEach: () => Promise<void>;
  /** Runs after every request, whatever its method (persistence of any change, GET side effects included). */
  afterEach: () => Promise<void>;
  /** Publishes the state mid-request (the pending idempotency mark) — needed only when tabs are not serialized by a lock. */
  checkpoint: () => Promise<void>;
  /** The document is being unloaded: its own loads are aborted, so a crash then is not logged (nobody reads the answer). */
  unloading?: () => boolean;
}

export function createRouter(m: Mock, handlers: Record<string, Handler>, hooks: RouterHooks) {
  let queue: Promise<unknown> = Promise.resolve();

  function match(path: string, method: string): { route: Route; params: Record<string, string> } | Response {
    const hits = ROUTES.filter((r) => r.re.test(path));
    if (hits.length === 0) return problemResponse(new ApiError(404, 'NOT_FOUND'));
    // A literal segment wins over a parameter (`/dictionaries/products/{id}/image` vs `/dictionaries/{name}/{id}`).
    const candidates = hits.filter((r) => r.op.method === (method === 'HEAD' ? 'GET' : method));
    if (candidates.length === 0) {
      const allow = [...new Set(hits.map((r) => r.op.method))].join(', ');
      return problemResponse(new ApiError(405, 'METHOD_NOT_ALLOWED', { headers: { Allow: allow } }));
    }
    const route = candidates.sort((a, b) => b.op.path.split('{').length - a.op.path.split('{').length).at(-1)!;
    const values = route.re.exec(path)!.slice(1);
    const params: Record<string, string> = {};
    route.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(values[i]!);
      } catch {
        params[n] = values[i]!;
      }
    });
    return { route, params };
  }

  const bearerOf = (request: Request): string | null =>
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;

  function authenticate(op: OperationMeta, request: Request, url: URL): Principal | null {
    const now = m.store.now();
    if (op.operationId === 'streamEvents') {
      const p = verifyAccessToken(m.cfg.secret, url.searchParams.get('access_token') ?? '', now);
      if (!p) throw new ApiError(401, 'UNAUTHORIZED');
      hitRateLimit(m, 'user', p.userId);
      return p;
    }
    if (!op.bearer) return null;
    const token = bearerOf(request);
    const p = token ? verifyAccessToken(m.cfg.secret, token, now) : null;
    if (op.signedAccess && (url.searchParams.has('exp') || url.searchParams.has('sig'))) {
      // Signed URL: the signature decides (checked by the handler); a valid Bearer still counts in `user`.
      if (p) hitRateLimit(m, 'user', p.userId);
      return p;
    }
    if (!p) throw new ApiError(401, 'UNAUTHORIZED');
    hitRateLimit(m, 'user', p.userId);
    const roleOk = op.roles.includes('ANY') || p.roles.some((r) => op.roles.includes(r));
    const adminOk = !op.orgAdmin || p.roles.includes('ADMIN') || p.orgAdmin;
    if (!roleOk || !adminOk) throw new ApiError(403, 'FORBIDDEN');
    return p;
  }

  async function handle(request: Request, requestId: string): Promise<Response> {
    const url = new URL(request.url);
    const raw = url.pathname;
    if (!raw.startsWith(`${PREFIX}/`) || raw.includes('//')) return problemResponse(new ApiError(404, 'NOT_FOUND'));
    const found = match(raw.slice(PREFIX.length), request.method);
    if (found instanceof Response) return found;
    const { route, params } = found;
    const op = route.op;
    const handler = handlers[op.operationId];
    if (!handler) return problemResponse(new ApiError(404, 'NOT_FOUND'));
    let pending: string | null = null;
    try {
      await hooks.beforeEach();
      m.store.requestId = requestId;
      const principal = authenticate(op, request, url);

      if (op.idempotent) {
        const key = request.headers.get('Idempotency-Key') ?? '';
        const body = await request.clone().text();
        const fingerprint = sha256hex(`${request.method} ${raw}\n${body}`);
        const storeKey = `idem:${principal!.userId}:${key}`;
        const stored = m.store.kvGet<IdemEntry>(storeKey) ?? null;
        const decision = idempotencyDecision({ key, stored, fingerprint }).decision;
        if (decision === 'INVALID_KEY') throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY');
        if (decision === 'CONFLICT') throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED');
        if (decision === 'REPLAY' && stored!.state === 'pending')
          throw new ApiError(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', { headers: { 'Retry-After': '1' } });
        if (decision === 'REPLAY') return json(stored!.status!, stored!.body, { 'Idempotent-Replayed': 'true' });
        // R48 `SET NX EX 60`: the pending mark is published before the operation runs, so another tab that is not
        // serialized with this one by a lock (no Web Locks) answers IDEMPOTENCY_KEY_IN_PROGRESS meanwhile.
        m.store.kvSet(storeKey, { fingerprint, state: 'pending' } satisfies IdemEntry, IDEMPOTENCY_PENDING_TTL_SEC);
        pending = storeKey;
        await hooks.checkpoint();
      }

      const ctx = makeCtx(m, request, url, op, params, principal);
      // The operation's refusal (a thrown ApiError, already rolled back) becomes its response here, so the rule below —
      // only a 2xx is kept (R48) — is what decides for every outcome.
      const response = await m.store
        .runAsync(op.operationId, principal?.userId ?? null, async () => handler(ctx))
        .catch((e: unknown) => {
          if (e instanceof ApiError) return problemResponse(e);
          throw e;
        });
      if (pending && response.status >= 200 && response.status < 300) {
        const body = response.headers.get('Content-Type')?.startsWith('application/json')
          ? ((await response.clone().json()) as unknown)
          : null;
        const { fingerprint } = m.store.kvGet<IdemEntry>(pending)!;
        m.store.kvSet(pending, { fingerprint, state: 'done', status: response.status, body } satisfies IdemEntry, IDEMPOTENCY_TTL_SEC);
        pending = null;
      }
      return response;
    } catch (e) {
      if (e instanceof ApiError) return problemResponse(e);
      // A download in flight when the page navigates away: the mock's asset fetch dies with the document ("Failed to
      // fetch") — not an error of the mock.
      if (!hooks.unloading?.()) console.error('[mock-api]', op.operationId, e);
      return problemResponse(new ApiError(500, 'INTERNAL'));
    } finally {
      // Not kept (a non-2xx answer or a crash): the key is free again.
      if (pending) m.store.kvDel(pending);
      await hooks.afterEach();
    }
  }

  /** X-Request-Id (the client's when it matches `^[A-Za-z0-9._-]{1,64}$`, R79) and X-Backend on every response. */
  async function tagged(request: Request): Promise<Response> {
    const own = request.headers.get('X-Request-Id');
    const requestId = own !== null && /^[A-Za-z0-9._-]{1,64}$/.test(own) ? own : randomUuid();
    const res = await handle(request, requestId);
    res.headers.set('X-Request-Id', requestId);
    res.headers.set('X-Backend', 'express');
    return res;
  }

  /** Runs `fn` between requests (never interleaved with one). */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };
  return { handle: (request: Request): Promise<Response> => exclusive(() => tagged(request)), exclusive };
}
