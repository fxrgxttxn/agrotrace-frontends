/**
 * createApp(container): the HTTP application. Order: request id + X-Backend (on every response, errors included) →
 * access log → JSON body (12 MiB) → /api/v1 routes → 404/405 fallback → the single problem handler.
 */
import express, { type Express } from 'express';
import type { Container } from './container.js';
import { contractMethods } from './contract.js';
import { accessLog } from './http/access-log.js';
import { JSON_BODY_LIMIT_BYTES, notFoundHandler, problemHandler } from './http/problem.js';
import { backendHeader, requestId } from './http/request-id.js';
import { docsRouter } from './modules/docs/routes.js';
import { healthRouter } from './modules/health/routes.js';

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  // Validators (ETag/If-None-Match) are the contract's business: only file downloads define them.
  app.set('etag', false);

  app.use(requestId());
  app.use(backendHeader('express'));
  app.use(accessLog(c.logger));
  app.use(
    express.json({
      limit: JSON_BODY_LIMIT_BYTES,
      strict: true,
      type: ['application/json', 'application/*+json'],
    }),
  );

  const api = express.Router();
  api.use('/health', healthRouter(c));
  api.use('/docs', docsRouter(c));
  app.use('/api/v1', api);

  app.use(notFoundHandler(c.contract ? contractMethods(c.contract.doc) : () => []));
  app.use(problemHandler(c.logger));
  return app;
}
