/**
 * `X-Request-Id` (spec 8.3, R79): a client value is kept only if it looks like one we would generate ourselves —
 * `^[A-Za-z0-9._-]{1,64}$` (the gateway's rule) — otherwise a UUID v4 is generated. The id is echoed on every
 * response (errors included), runs through the request context into logs and outbox events.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '../context.js';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function acceptRequestId(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && REQUEST_ID_PATTERN.test(v) ? v : randomUUID();
}

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = acceptRequestId(req.headers['x-request-id']);
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    runWithContext({ requestId: id }, next);
  };
}

/** `X-Backend: express` on every response (spec 8.3). */
export function backendHeader(name: 'express'): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Backend', name);
    next();
  };
}
