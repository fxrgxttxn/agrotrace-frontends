/**
 * Rate limits (R30, contracts/rules/rate-limits.json): fixed-window counters in the shared Redis. Each hit: INCR
 * `rl:{scope}:{subject}:{windowStartEpochSec}`, EXPIRE windowSec when the result is 1 (one MULTI, so a counter never
 * lives without a TTL); over the limit → 429 RATE_LIMITED, `Retry-After` = seconds to the window end (≥ 1),
 * `params {scope, limit, windowSec}`. The `user` scope applies to every Bearer-authenticated request (http/auth.ts);
 * the others to the operations listing them in `x-rate-limit` (login-ip, forgot here; complaint-ip in Task 11).
 */
import type { Redis } from 'ioredis';
import rules from '../../../contracts/rules/rate-limits.json' with { type: 'json' };
import { AppProblem } from './problem.js';

export type RateScope = 'user' | 'login-ip' | 'forgot' | 'complaint-ip';

interface Limit {
  scope: RateScope;
  limit: number;
  windowSec: number;
}

const LIMITS = new Map<RateScope, Limit>(
  (rules.limits as Limit[]).map((l) => [l.scope, { scope: l.scope, limit: l.limit, windowSec: l.windowSec }]),
);

/** P10: `RATE_LIMIT_OVERRIDES` — replaces `limit` of the named scopes (test stand only); windows and keys stay. */
export type RateLimitOverrides = Partial<Record<RateScope, number>>;

export const RATE_SCOPES = [...LIMITS.keys()];

export function rateLimitOf(scope: RateScope, overrides: RateLimitOverrides = {}): Limit {
  const l = LIMITS.get(scope);
  if (!l) throw new Error(`rate-limits.json has no scope ${scope}`);
  const o = overrides[scope];
  return o === undefined ? l : { ...l, limit: o };
}

/**
 * Counts one request of `subject` in `scope`; throws 429 when this request is over the limit. The subject of the
 * `forgot` scope is the lower-cased email (the caller passes it lower-cased).
 */
export async function hitRateLimit(
  redis: Redis,
  scope: RateScope,
  subject: string,
  overrides: RateLimitOverrides = {},
  nowMs = Date.now(),
): Promise<void> {
  const { limit, windowSec } = rateLimitOf(scope, overrides);
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;
  const key = `rl:${scope}:${subject}:${windowStart}`;
  const res = await redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
  const err = res?.[0]?.[0];
  if (err) throw err;
  const count = Number(res?.[0]?.[1]);
  if (count > limit) {
    const retryAfter = Math.max(1, windowStart + windowSec - nowSec);
    throw new AppProblem(429, 'RATE_LIMITED', {
      params: { scope, limit, windowSec },
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
}
