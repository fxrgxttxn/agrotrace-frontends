/**
 * createApp(container): the HTTP application. Order: request id + X-Backend (on every response, errors included) →
 * access log → method guard (405 before any route or body parsing) → JSON body (12 MiB) → /api/v1 routes →
 * 404 fallback → the single problem handler. Routing is case-sensitive and strict (P8): `/Health/live` and
 * `/health/live/` are not the contract path `/health/live`.
 */
import express, { type Express } from 'express';
import type { Container } from './container.js';
import { contractMethods } from './contract.js';
import { accessLog } from './http/access-log.js';
import {
  JSON_BODY_LIMIT_BYTES,
  methodGuard,
  notFoundHandler,
  problemHandler,
  rejectEmptySegments,
} from './http/problem.js';
import { backendHeader, requestId } from './http/request-id.js';
import { docsRouter } from './modules/docs/routes.js';
import { healthRouter } from './modules/health/routes.js';

export const ROUTER_OPTIONS = { caseSensitive: true, strict: true } as const;

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // Validators (ETag/If-None-Match) are the contract's business: only file downloads define them.
  app.set('etag', false);

  app.use(requestId());
  app.use(backendHeader('express'));
  app.use(accessLog(c.logger));
  app.use(rejectEmptySegments());
  // Every route — present and future — inherits the contract's method set: an undeclared method (OPTIONS included)
  // on a contract path is 405 METHOD_NOT_ALLOWED with the contract's Allow, never Express's automatic answer.
  app.use(methodGuard(c.contract ? contractMethods(c.contract.doc) : () => []));
  app.use(
    express.json({
      limit: JSON_BODY_LIMIT_BYTES,
      strict: true,
      type: ['application/json', 'application/*+json'],
    }),
  );

  const api = express.Router(ROUTER_OPTIONS);
  api.use('/health', healthRouter(c));
  api.use('/docs', docsRouter(c));
  app.use('/api/v1', api);

  app.use(notFoundHandler());
  app.use(problemHandler(c.logger));
  return app;
}
