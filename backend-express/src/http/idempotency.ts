/**
 * `Idempotency-Key` (BR-11, R48, R53; components/parameters.yaml#/IdempotencyKey) for operations with
 * `x-idempotent: true`. Runs after `guard()` (authentication, `x-roles`) and before the operation's own checks.
 *
 * - key missing or not `^[A-Za-z0-9_-]{8,128}$` (`idempotencyDecision`) → 400 INVALID_IDEMPOTENCY_KEY;
 * - Redis key `idem:{userId}:{key}`; fingerprint = sha256 hex of `"{METHOD} {path}\n"` + the raw body bytes (path
 *   without the query string);
 * - `SET NX EX 60` of `{"fingerprint", "state": "pending"}`; when the key exists: another fingerprint → 409
 *   IDEMPOTENCY_KEY_REUSED; same and pending → 409 IDEMPOTENCY_KEY_IN_PROGRESS + `Retry-After: 1`; same and done → the
 *   stored response again (status, `body` re-serialized as application/json, `Idempotent-Replayed: true`);
 * - the owner's response decides before it is sent: 2xx → the Lua compare-and-set stores
 *   `{"fingerprint", "state": "done", "status", "body"}` for 86400 s; anything else (a 4xx/5xx problem, a request that
 *   ends without a response) → the Lua compare-and-delete frees the key. Both scripts touch only the owner's own
 *   pending record (fingerprint + state compared after `cjson.decode`), never a finished or foreign one.
 */
import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { idempotencyDecision } from '@agrotrace/domain';
import type { Container } from '../container.js';
import { ah } from './async.js';
import { principalOf } from './auth.js';
import { AppProblem } from './problem.js';

export const PENDING_TTL_SEC = 60;
export const DONE_TTL_SEC = 86400;

export interface IdemRecord {
  fingerprint: string;
  state: 'pending' | 'done';
  status?: number;
  body?: unknown;
}

/** The storage operations the protocol needs (Redis in production, a map in unit tests). */
export interface IdemStore {
  /** SET NX EX PENDING_TTL_SEC; false — the key exists. */
  claim(key: string, fingerprint: string): Promise<boolean>;
  get(key: string): Promise<IdemRecord | null>;
  /** Compare-and-set to `done` (only the own pending record); false — not stored. */
  complete(key: string, fingerprint: string, status: number, body: unknown): Promise<boolean>;
  /** Compare-and-delete (only the own pending record). */
  release(key: string, fingerprint: string): Promise<boolean>;
}

const OWN_PENDING = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, d = pcall(cjson.decode, v)
if not ok or type(d) ~= 'table' or d.fingerprint ~= ARGV[1] or d.state ~= 'pending' then return 0 end
`;
const COMPLETE_LUA = `${OWN_PENDING}redis.call('SET', KEYS[1], ARGV[2], 'EX', ${DONE_TTL_SEC})
return 1`;
const RELEASE_LUA = `${OWN_PENDING}redis.call('DEL', KEYS[1])
return 1`;

export function redisIdemStore(redis: Redis): IdemStore {
  return {
    async claim(key, fingerprint) {
      const r = await redis.set(
        key,
        JSON.stringify({ fingerprint, state: 'pending' }),
        'EX',
        PENDING_TTL_SEC,
        'NX',
      );
      return r === 'OK';
    },
    async get(key) {
      const v = await redis.get(key);
      if (v === null) return null;
      try {
        const d = JSON.parse(v) as IdemRecord;
        return d && typeof d === 'object' && typeof d.fingerprint === 'string' ? d : null;
      } catch {
        return null;
      }
    },
    async complete(key, fingerprint, status, body) {
      const value = JSON.stringify({ fingerprint, state: 'done', status, body });
      return Number(await redis.eval(COMPLETE_LUA, 1, key, fingerprint, value)) === 1;
    },
    async release(key, fingerprint) {
      return Number(await redis.eval(RELEASE_LUA, 1, key, fingerprint)) === 1;
    },
  };
}

/** sha256 hex of `"{METHOD} {path}\n"` followed by the raw request body bytes. */
export function requestFingerprint(method: string, path: string, rawBody: Buffer | undefined): string {
  return createHash('sha256')
    .update(Buffer.from(`${method} ${path}\n`, 'utf8'))
    .update(rawBody ?? Buffer.alloc(0))
    .digest('hex');
}

/** The raw body bytes kept by the JSON parser (app.ts `verify`). */
export const rawBodyOf = (req: Request): Buffer | undefined =>
  (req as Request & { rawBody?: Buffer }).rawBody;

/**
 * Wraps `res.send` of the owning request: the response is held until the record is completed (2xx) or released
 * (anything else), so a client that retries right after the answer never meets its own pending mark.
 */
function settleBeforeSend(
  res: Response,
  store: IdemStore,
  key: string,
  fingerprint: string,
  logger: Container['logger'],
) {
  let settled = false;
  const settle = async (status: number, body: unknown): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      if (status >= 200 && status < 300) await store.complete(key, fingerprint, status, body);
      else await store.release(key, fingerprint);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'idempotency record not settled');
    }
  };
  const send = res.send.bind(res);
  res.send = ((body?: unknown) => {
    const status = res.statusCode;
    let json: unknown = null;
    if (status >= 200 && status < 300 && body !== undefined) {
      try {
        json =
          typeof body === 'string'
            ? JSON.parse(body)
            : Buffer.isBuffer(body)
              ? JSON.parse(body.toString('utf8'))
              : body;
      } catch {
        json = null;
      }
    }
    void settle(status, json).then(() => send(body as never));
    return res;
  }) as Response['send'];
  // A response sent without res.send (e.g. end()): settled after the fact. A request that ends without any response
  // (client gone, crash after the headers): the key is freed.
  res.on('finish', () => void settle(res.statusCode, null));
  res.on('close', () => {
    if (!res.writableFinished) void settle(500, null);
  });
}

export function idempotency(c: Container, store: IdemStore = redisIdemStore(c.redis)): RequestHandler {
  return ah(async (req, res, next) => {
    const p = principalOf(res);
    const key = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(req.method, req.originalUrl.split('?')[0]!, rawBodyOf(req));
    const k = typeof key === 'string' ? key : '';
    if (idempotencyDecision({ key: k, stored: null, fingerprint }).decision === 'INVALID_KEY')
      throw new AppProblem(400, 'INVALID_IDEMPOTENCY_KEY');
    const redisKey = `idem:${p.userId}:${k}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await store.claim(redisKey, fingerprint)) {
        settleBeforeSend(res, store, redisKey, fingerprint, c.logger);
        next();
        return;
      }
      const stored = await store.get(redisKey);
      if (!stored) continue; // expired between SET NX and GET — claim again
      const decision = idempotencyDecision({ key: k, stored, fingerprint }).decision;
      if (decision === 'CONFLICT') throw new AppProblem(409, 'IDEMPOTENCY_KEY_REUSED');
      if (stored.state !== 'done')
        throw new AppProblem(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', { headers: { 'Retry-After': '1' } });
      res.setHeader('Idempotent-Replayed', 'true');
      res
        .status(stored.status ?? 200)
        .type('application/json')
        .send(JSON.stringify(stored.body ?? null));
      return;
    }
    throw new AppProblem(409, 'IDEMPOTENCY_KEY_IN_PROGRESS', { headers: { 'Retry-After': '1' } });
  });
}
