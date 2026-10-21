/**
 * /recalls/* and /recall-tasks/* (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml). Order of checks: guard
 * (401, x-roles) → `Idempotency-Key` (confirmRecallTask, x-idempotent) → parameters (`If-Match`) and body in one 400
 * (P36) → the service (locks, 404, version, transitions).
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idempotency } from '../../http/idempotency.js';
import { readIfMatch } from '../../http/if-match.js';
import { idParam } from '../../http/params.js';
import { recallsService } from './service.js';

export function recallsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = recallsService(c);

  r.get(
    '/recalls',
    guard(c, 'listRecalls'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(req.query));
    }),
  );
  r.post(
    '/recalls',
    guard(c, 'createRecall'),
    ah(async (req, res) => {
      const out = await svc.create(principalOf(res), req.body);
      res.status(out.status).json(out.body);
    }),
  );
  r.get(
    '/recalls/:id',
    guard(c, 'getRecall'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(idParam(req)));
    }),
  );
  r.get(
    '/recalls/:id/graph',
    guard(c, 'getRecallGraph'),
    ah(async (req, res) => {
      res.status(200).json(await svc.graph(idParam(req)));
    }),
  );
  r.get(
    '/recall-tasks',
    guard(c, 'listRecallTasks'),
    ah(async (req, res) => {
      res.status(200).json(await svc.listTasks(principalOf(res), req.query));
    }),
  );
  r.post(
    '/recall-tasks/:id/confirm',
    guard(c, 'confirmRecallTask'),
    idempotency(c),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.confirm(principalOf(res), id, readIfMatch(req), req.body));
    }),
  );
  return r;
}
