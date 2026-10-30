/**
 * `X-Request-Id` (spec 8.3, R79): a client value is kept only if it looks like one we would generate ourselves —
 * `^[A-Za-z0-9._-]{1,64}$` (the gateway's rule) — otherwise a UUID v4 is generated. The id is echoed on every
 * response (errors included), runs through the request context into logs and outbox events.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { runWithContext } from '../context.js';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function acceptRequestId(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && REQUEST_ID_PATTERN.test(v) ? v : randomUUID();
}

/**
 * The client IP: Express `req.ip` with `trust proxy` = 1 (app.ts) — the last `X-Forwarded-For` entry, i.e. the peer
 * the gateway saw (nginx appends it with `$proxy_add_x_forwarded_for`); without the header, the socket peer. IPv4
 * mapped into IPv6 (`::ffff:10.0.0.1`, in any case — hex digits are case-free, so `::FFFF:` is the same client and
 * the same rate-limit bucket, as on django and laravel) is shown as plain IPv4. A forwarded value that is not an IP
 * literal falls back to the socket peer (requestId).
 */
export function clientIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const ip = raw.toLowerCase().startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  return isIP(ip) ? ip : null;
}

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = acceptRequestId(req.headers['x-request-id']);
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    runWithContext(
      { requestId: id, ip: clientIp(req.ip) ?? clientIp(req.socket.remoteAddress), events: [] },
      next,
    );
  };
}

/** `X-Backend: express` on every response (spec 8.3). */
export function backendHeader(name: 'express'): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Backend', name);
    next();
  };
}
