/** One JSON line per finished request: method, full path without the query string (signed URLs, R88 M1), status, ms. */
import type { RequestHandler } from 'express';
import type { Logger } from '../logger.js';

export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const path = req.originalUrl.split('?')[0]!;
      // Liveness probes (docker healthcheck every few seconds) only at debug level.
      const level = path === '/api/v1/health/live' && res.statusCode === 200 ? 'debug' : 'info';
      logger[level](
        {
          requestId: res.locals.requestId as string,
          method: req.method,
          path,
          status: res.statusCode,
          ms: Math.round(ms * 10) / 10,
        },
        'request',
      );
    });
    next();
  };
}
