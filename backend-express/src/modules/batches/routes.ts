/** /batches/* (contracts/openapi/paths/batches.yaml): HTTP mapping of the batches, QR and documents services. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idempotency } from '../../http/idempotency.js';
import { ifMatchVersion } from '../../http/if-match.js';
import { idParam, QueryReader } from '../../http/params.js';
import { validationProblem } from '../../http/problem.js';
import { QrRequestSchema } from '@agrotrace/validation';
import { parseBody } from '../../http/body.js';
import { documentsService } from '../documents/service.js';
import { qrService } from './qr.js';
import { batchesService } from './service.js';

export function batchesRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = batchesService(c);
  const qr = qrService(c, svc);
  const docs = documentsService(c, svc);

  r.get(
    '/batches',
    guard(c, 'listBatches'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/batches',
    guard(c, 'createBatch'),
    ah(async (req, res) => {
      res.status(201).json(await svc.create(principalOf(res), req.body));
    }),
  );
  r.get(
    '/batches/:id',
    guard(c, 'getBatch'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(principalOf(res), idParam(req)));
    }),
  );
  r.get(
    '/batches/:id/graph',
    guard(c, 'getBatchGraph'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.graph(principalOf(res), id, req.query));
    }),
  );
  r.get(
    '/batches/:id/history',
    guard(c, 'getBatchHistory'),
    ah(async (req, res) => {
      res.status(200).json(await svc.history(principalOf(res), idParam(req)));
    }),
  );
  r.get(
    '/batches/:id/path',
    guard(c, 'getBatchPath'),
    ah(async (req, res) => {
      res.status(200).json(await svc.path(principalOf(res), idParam(req)));
    }),
  );
  r.post(
    '/batches/:id/qr',
    guard(c, 'createBatchQr'),
    ah(async (req, res) => {
      const id = idParam(req);
      // requestBody optional: absent (the JSON parser leaves `{}`) or exactly `{}`.
      parseBody(QrRequestSchema, req.body ?? {});
      res.status(201).json(await qr.create(principalOf(res), id));
    }),
  );
  r.get(
    '/batches/:id/qr',
    guard(c, 'downloadBatchQr'),
    ah(async (req, res) => {
      const id = idParam(req);
      const q = new QueryReader(req.query);
      const format = q.enumOf('format', ['png', 'pdf'] as const);
      if (!q.has('format')) throw validationProblem({ ...q.errors, format: ['validation.required'] });
      q.done();
      await qr.download(req, res, principalOf(res), id, format!);
    }),
  );
  r.get(
    '/batches/:id/documents',
    guard(c, 'getBatchDocuments'),
    ah(async (req, res) => {
      res.status(200).json(await docs.get(principalOf(res), idParam(req)));
    }),
  );
  r.post(
    '/batches/:id/documents/vsd/retry',
    guard(c, 'retryBatchVsdImport'),
    idempotency(c),
    ah(async (req, res) => {
      res.status(202).json(await docs.retry(principalOf(res), idParam(req)));
    }),
  );
  r.post(
    '/batches/:id/on-sale',
    guard(c, 'putBatchOnSale'),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      res.status(200).json(await svc.putOnSale(principalOf(res), id, version));
    }),
  );
  r.post(
    '/batches/:id/sold',
    guard(c, 'markBatchSold'),
    ah(async (req, res) => {
      const id = idParam(req);
      const version = ifMatchVersion(req);
      res.status(200).json(await svc.markSold(principalOf(res), id, version));
    }),
  );
  return r;
}
