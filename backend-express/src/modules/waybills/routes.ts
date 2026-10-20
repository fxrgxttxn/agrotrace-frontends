/**
 * /waybills/* (contracts/openapi/paths/waybills.yaml). Order of checks: guard (401, x-roles) → `Idempotency-Key`
 * (x-idempotent) → parameters (`If-Match`) and body → the service (locks, 404, side, version, transition, references,
 * per-item rules).
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idempotency } from '../../http/idempotency.js';
import { ifMatchVersion } from '../../http/if-match.js';
import { idParam } from '../../http/params.js';
import { waybillsService } from './service.js';

export function waybillsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = waybillsService(c);

  r.get(
    '/waybills',
    guard(c, 'listWaybills'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/waybills',
    guard(c, 'createWaybill'),
    idempotency(c),
    ah(async (req, res) => {
      res.status(201).json(await svc.create(principalOf(res), req.body));
    }),
  );
  r.get(
    '/waybills/:id',
    guard(c, 'getWaybill'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(principalOf(res), idParam(req)));
    }),
  );
  r.delete(
    '/waybills/:id',
    guard(c, 'deleteWaybill'),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      await svc.remove(principalOf(res), id, version);
      res.status(204).end();
    }),
  );
  r.post(
    '/waybills/:id/send',
    guard(c, 'sendWaybill'),
    idempotency(c),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      res.status(200).json(await svc.send(principalOf(res), id, version));
    }),
  );
  r.post(
    '/waybills/:id/accept',
    guard(c, 'acceptWaybill'),
    idempotency(c),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      res.status(200).json(await svc.accept(principalOf(res), id, version, req.body));
    }),
  );
  r.post(
    '/waybills/:id/reject',
    guard(c, 'rejectWaybill'),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      res.status(200).json(await svc.reject(principalOf(res), id, version, req.body));
    }),
  );
  return r;
}
