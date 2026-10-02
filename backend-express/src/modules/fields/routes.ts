/** /fields/*, /treatments/{id} (contracts/openapi/paths/fields.yaml, treatments.yaml): HTTP mapping of the service. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idParam } from '../../http/params.js';
import { fieldsService } from './service.js';

export function fieldsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = fieldsService(c);

  r.get(
    '/fields',
    guard(c, 'listFields'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/fields',
    guard(c, 'createField'),
    ah(async (req, res) => {
      res.status(201).json(await svc.create(principalOf(res), req.body));
    }),
  );
  r.get(
    '/fields/:id',
    guard(c, 'getField'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(principalOf(res), idParam(req)));
    }),
  );
  r.put(
    '/fields/:id',
    guard(c, 'updateField'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.update(principalOf(res), id, req.body));
    }),
  );
  r.delete(
    '/fields/:id',
    guard(c, 'deleteField'),
    ah(async (req, res) => {
      await svc.remove(principalOf(res), idParam(req));
      res.status(204).end();
    }),
  );
  r.get(
    '/fields/:id/treatments',
    guard(c, 'listFieldTreatments'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.listTreatments(principalOf(res), id, req.query));
    }),
  );
  r.post(
    '/fields/:id/treatments',
    guard(c, 'createTreatment'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(201).json(await svc.createTreatment(principalOf(res), id, req.body));
    }),
  );
  r.put(
    '/treatments/:id',
    guard(c, 'updateTreatment'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.updateTreatment(principalOf(res), id, req.body));
    }),
  );
  return r;
}
