/** Shared Redis (R82): one client per process; commands queue while it (re)connects. */
import { Redis } from 'ioredis';
import type { Logger } from '../logger.js';

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  let down = false;
  redis.on('error', (err) => {
    if (!down) logger.warn({ err: err.message }, 'redis unavailable');
    down = true;
  });
  redis.on('ready', () => {
    if (down) logger.info('redis reconnected');
    down = false;
  });
  return redis;
}
