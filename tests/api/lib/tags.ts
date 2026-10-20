/**
 * P10: rate-limit tests are named `[ratelimit] …` and run only in `./at api:test <backend> --ratelimits`
 * (API_RATELIMITS=1), against the backend without RATE_LIMIT_OVERRIDES. The default run (api-test overrides) skips
 * them, so no other test ever depends on a limit.
 */
import { it } from 'vitest';

export const RATELIMITS = process.env.API_RATELIMITS === '1';

export function itRateLimit(name: string, fn: () => Promise<void>, timeout?: number): void {
  (RATELIMITS ? it : it.skip)(`[ratelimit] ${name}`, fn, timeout);
}
