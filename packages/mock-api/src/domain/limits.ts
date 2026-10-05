import limits from '../../../../contracts/rules/rate-limits.json' with { type: 'json' };
import { ApiError } from '../http/problem.js';
import type { Mock } from '../runtime.js';

export type Scope = 'user' | 'login-ip' | 'forgot' | 'complaint-ip';

export const CLIENT_IP = '127.0.0.1';

export function hitRateLimit(m: Mock, scope: Scope, subject: string): void {
  if (!m.cfg.rateLimits) return;
  const rule = limits.limits.find((l) => l.scope === scope)!;
  const nowSec = Math.floor(m.store.now() / 1000);
  const start = Math.floor(nowSec / rule.windowSec) * rule.windowSec;
  const key = `rl:${scope}:${subject}:${start}`;
  const count = m.cfg.counters.hit(key, (start + rule.windowSec) * 1000, m.store.now());
  if (count > rule.limit)
    throw new ApiError(429, 'RATE_LIMITED', {
      params: { scope, limit: rule.limit, windowSec: rule.windowSec },
      headers: { 'Retry-After': String(Math.max(1, start + rule.windowSec - nowSec)) },
    });
}
