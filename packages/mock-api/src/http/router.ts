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
import { sha256hex } from '../lib/crypto.js';
import type { Mock } from '../runtime.js';
import type { Principal } from '../store/types.js';
import { json, makeCtx, problemResponse, type Handler } from './context.js';
import { ApiError } from './problem.js';

const PREFIX = '/api/v1';
const IDEMPOTENCY_TTL_SEC = 86_400;

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
  /** Runs before every operation (the schedulers catching up with the clock). */
  beforeEach: () => void;
  /** Runs after every operation that may have changed state (persistence). */
  afterWrite: () => void;
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

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const raw = url.pathname;
    if (!raw.startsWith(`${PREFIX}/`) || raw.includes('//')) return problemResponse(new ApiError(404, 'NOT_FOUND'));
    const found = match(raw.slice(PREFIX.length), request.method);
    if (found instanceof Response) return found;
    const { route, params } = found;
    const op = route.op;
    const handler = handlers[op.operationId];
    if (!handler) return problemResponse(new ApiError(404, 'NOT_FOUND'));
    try {
      hooks.beforeEach();
      const principal = authenticate(op, request, url);

      let idem: { key: string; fingerprint: string } | null = null;
      if (op.idempotent) {
        const key = request.headers.get('Idempotency-Key') ?? '';
        const body = await request.clone().text();
        const fingerprint = sha256hex(`${request.method} ${raw}\n${body}`);
        const storeKey = `idem:${principal!.userId}:${key}`;
        const stored = m.store.kvGet<{ fingerprint: string; status: number; body: unknown }>(storeKey) ?? null;
        const decision = idempotencyDecision({ key, stored, fingerprint }).decision;
        if (decision === 'INVALID_KEY') throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY');
        if (decision === 'CONFLICT') throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED');
        if (decision === 'REPLAY') return json(stored!.status, stored!.body, { 'Idempotent-Replayed': 'true' });
        idem = { key: storeKey, fingerprint };
      }

      const ctx = makeCtx(m, request, url, op, params, principal);
      const response = await m.store.runAsync(op.operationId, principal?.userId ?? null, async () => handler(ctx));
      if (idem && response.status >= 200 && response.status < 300) {
        const body = response.headers.get('Content-Type')?.startsWith('application/json')
          ? ((await response.clone().json()) as unknown)
          : null;
        m.store.kv.set(idem.key, {
          value: { fingerprint: idem.fingerprint, state: 'done', status: response.status, body },
          expiresAt: m.store.now() + IDEMPOTENCY_TTL_SEC * 1000,
        });
      }
      return response;
    } catch (e) {
      if (e instanceof ApiError) return problemResponse(e);
      console.error('[mock-api]', op.operationId, e);
      return problemResponse(new ApiError(500, 'INTERNAL'));
    } finally {
      if (request.method !== 'GET') hooks.afterWrite();
    }
  }

  /** Serializes requests; the SSE stream returns as soon as it is open. */
  return (request: Request): Promise<Response> => {
    const next = queue.then(() => handle(request));
    queue = next.catch(() => undefined);
    return next;
  };
}
