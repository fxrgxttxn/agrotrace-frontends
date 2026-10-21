/**
 * /lab-tests/* (contracts/openapi/paths/lab.yaml). Order of checks: guard (401, x-roles) → parameters (`If-Match`) and
 * body in one 400 (P36) → the service (lock, 404, version, transition, per-operation steps); uploads: the multipart
 * reader (400, 413) first.
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { readIfMatch } from '../../http/if-match.js';
import { readFileUpload } from '../../http/multipart.js';
import { idParam } from '../../http/params.js';
import { CACHE_PRIVATE, sendFile } from '../files/download.js';
import { labService, PROTOCOL_MAX_BYTES } from './service.js';

export function labRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = labService(c);

  r.get(
    '/lab-tests',
    guard(c, 'listLabTests'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/lab-tests',
    guard(c, 'createLabTest'),
    ah(async (req, res) => {
      res.status(201).json(await svc.create(principalOf(res), req.body));
    }),
  );
  r.get(
    '/lab-tests/:id',
    guard(c, 'getLabTest'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(principalOf(res), idParam(req)));
    }),
  );
  r.post(
    '/lab-tests/:id/sample',
    guard(c, 'registerLabSample'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.sample(principalOf(res), id, readIfMatch(req), req.body));
    }),
  );
  r.post(
    '/lab-tests/:id/results',
    guard(c, 'submitLabResults'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.submit(principalOf(res), id, readIfMatch(req), req.body));
    }),
  );
  r.put(
    '/lab-tests/:id/protocol',
    guard(c, 'uploadLabProtocol'),
    ah(async (req, res) => {
      const id = idParam(req);
      const upload = await readFileUpload(req, PROTOCOL_MAX_BYTES);
      res.status(200).json(await svc.uploadProtocol(principalOf(res), id, upload));
    }),
  );
  r.get(
    '/lab-tests/:id/protocol',
    guard(c, 'downloadLabProtocol'),
    ah(async (req, res) => {
      const file = await svc.protocolFile(principalOf(res), idParam(req));
      await sendFile(c, req, res, file, 480, CACHE_PRIVATE);
    }),
  );
  return r;
}
