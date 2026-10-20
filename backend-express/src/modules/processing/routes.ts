/** /processing (contracts/openapi/paths/processing.yaml): HTTP mapping of the processing service. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { processingService } from './service.js';

export function processingRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = processingService(c);
  r.post(
    '/processing',
    guard(c, 'processBatches'),
    ah(async (req, res) => {
      res.status(201).json(await svc.process(principalOf(res), req.body));
    }),
  );
  return r;
}
