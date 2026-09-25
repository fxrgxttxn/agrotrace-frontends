/**
 * /dictionaries/* (contracts/openapi/paths/dictionaries.yaml) and GET /public/regions (public.yaml): HTTP mapping of
 * the dictionaries service and the import. Path parameters are checked before the body (400), the guard before both.
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { readFileUpload } from '../../http/multipart.js';
import { idParam } from '../../http/params.js';
import { IMPORT_MAX_BYTES, importDictionary } from './import.js';
import { dictionariesService, PRODUCT_IMAGE_MAX_BYTES } from './service.js';
import { dictNameParam } from './store.js';

export function dictionariesRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = dictionariesService(c);

  r.get(
    '/dictionaries/:name',
    guard(c, 'listDictionary'),
    ah(async (req, res) => {
      const name = dictNameParam(req);
      res.status(200).json(await svc.list(principalOf(res), name, req.query));
    }),
  );
  r.post(
    '/dictionaries/:name',
    guard(c, 'createDictionaryEntry'),
    ah(async (req, res) => {
      const name = dictNameParam(req);
      res.status(201).json(await svc.create(principalOf(res), name, req.body));
    }),
  );
  r.put(
    '/dictionaries/products/:id/image',
    guard(c, 'uploadProductImage'),
    ah(async (req, res) => {
      const id = idParam(req);
      const upload = await readFileUpload(req, PRODUCT_IMAGE_MAX_BYTES);
      res.status(200).json(await svc.uploadImage(principalOf(res), id, upload));
    }),
  );
  r.post(
    '/dictionaries/:name/import',
    guard(c, 'importDictionary'),
    ah(async (req, res) => {
      const name = dictNameParam(req);
      const upload = await readFileUpload(req, IMPORT_MAX_BYTES);
      res.status(200).json(await importDictionary(c, principalOf(res), name, upload.bytes));
    }),
  );
  r.put(
    '/dictionaries/:name/:id',
    guard(c, 'updateDictionaryEntry'),
    ah(async (req, res) => {
      const name = dictNameParam(req);
      const id = idParam(req);
      res.status(200).json(await svc.update(principalOf(res), name, id, req.body));
    }),
  );
  r.delete(
    '/dictionaries/:name/:id',
    guard(c, 'deleteDictionaryEntry'),
    ah(async (req, res) => {
      const name = dictNameParam(req);
      const id = idParam(req);
      await svc.remove(principalOf(res), name, id);
      res.status(204).end();
    }),
  );
  r.get(
    '/public/regions',
    ah(async (_req, res) => {
      res.status(200).json(await svc.publicRegions());
    }),
  );
  return r;
}
