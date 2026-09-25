/**
 * The shared Redis (R82) as the contract describes it (info.description "Shared Redis keys"): tests read and write
 * only keys whose name and value format the contract fixes — e.g. an `invite:{sha256hex(token)}` for an invitation no
 * API can issue yet, or dropping a `2fa:{challengeId}` to stand in for its 5-minute TTL. Backend-agnostic by
 * construction: the three backends share these formats.
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

let client: Redis | null = null;

export function redis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('lib/redis: set REDIS_URL');
  client ??= new Redis(url, { maxRetriesPerRequest: 2 });
  return client;
}

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Contract R30: the window start of a fixed-window counter. */
export const windowStart = (windowSec: number, nowSec = Math.floor(Date.now() / 1000)): number =>
  Math.floor(nowSec / windowSec) * windowSec;

/**
 * Waits until at least `marginSec` remain in the current `windowSec` window, so that a test counting requests in one
 * fixed window (R30) cannot straddle two.
 */
export async function awayFromWindowEdge(windowSec: number, marginSec: number): Promise<void> {
  const now = Date.now() / 1000;
  const left = windowStart(windowSec, Math.floor(now)) + windowSec - now;
  if (left < marginSec) await new Promise((r) => setTimeout(r, (left + 0.2) * 1000));
}

export async function closeRedis(): Promise<void> {
  if (client) await client.quit();
  client = null;
}
