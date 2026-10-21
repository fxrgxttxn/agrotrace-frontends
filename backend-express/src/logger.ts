/** pino JSON logs to stdout; every line of a request carries its `requestId` (context.ts). */
import { pino, type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context.js';

export type { Logger };

/** Keys whose values never reach the logs (P8), at any depth up to REDACT_DEPTH below the log object. */
export const SECRET_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'access_token',
  'secret',
  'totpSecret',
  'authorization',
  'cookie',
  'set-cookie',
  'idempotencyKey',
  // Review M12 (defence in depth; none is logged today): refresh cookie value, TOTP code, ALTCHA payload, URL signature.
  'refresh',
  'totp',
  'altcha',
  'sig',
];
const REDACT_DEPTH = 4;

/** pino redact paths: `key`, `*.key`, `*.*.key`, … (pino wildcards match exactly one level). */
export function redactPaths(keys: readonly string[] = SECRET_KEYS, depth = REDACT_DEPTH): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const leaf = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
    for (let d = 0; d <= depth; d++) {
      const prefix = Array.from({ length: d }, () => '*').join('.');
      out.push(prefix ? (leaf.startsWith('[') ? `${prefix}${leaf}` : `${prefix}.${leaf}`) : leaf);
    }
  }
  return out;
}

export function createLogger(
  opts: { level: string; process: 'api' | 'worker' | 'scheduler' },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: opts.level,
      base: { backend: 'express', process: opts.process },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Secrets never reach the logs, whatever a caller passes in, however deeply nested.
      redact: { paths: redactPaths(), censor: '***' },
      mixin() {
        const ctx = currentContext();
        const requestId = ctx?.requestId ?? ctx?.eventRequestId;
        return requestId ? { requestId } : {};
      },
    },
    destination,
  );
}
