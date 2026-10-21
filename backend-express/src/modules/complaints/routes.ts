/**
 * /complaints/* (contracts/openapi/paths/complaints.yaml), INSPECTOR only. Order: guard (401, x-roles) → parameters and
 * body (400) → the service (lock, 404, transition, references).
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idParam } from '../../http/params.js';
import { complaintsService } from './service.js';

export function complaintsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = complaintsService(c);

  r.get(
    '/complaints',
    guard(c, 'listComplaints'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(req.query));
    }),
  );
  r.get(
    '/complaints/:id',
    guard(c, 'getComplaint'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(idParam(req)));
    }),
  );
  r.post(
    '/complaints/:id/review',
    guard(c, 'startComplaintReview'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.review(principalOf(res), id, req.body));
    }),
  );
  r.post(
    '/complaints/:id/decision',
    guard(c, 'decideComplaint'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.decide(principalOf(res), id, req.body));
    }),
  );
  return r;
}
