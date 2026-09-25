/** pino JSON logs to stdout; every line of a request carries its `requestId` (context.ts). */
import { pino, type Logger } from 'pino';
import { currentRequestId } from './context.js';

export type { Logger };

export function createLogger(opts: { level: string; process: 'api' | 'worker' | 'scheduler' }): Logger {
  return pino({
    level: opts.level,
    base: { backend: 'express', process: opts.process },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Secrets never reach the logs, whatever a caller passes in.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.accessToken'],
      censor: '***',
    },
    mixin() {
      const requestId = currentRequestId();
      return requestId ? { requestId } : {};
    },
  });
}
