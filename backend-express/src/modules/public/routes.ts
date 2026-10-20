/**
 * /public/batches/{publicCode}, /public/batches/{publicCode}/complaints, /public/captcha (contracts/openapi/paths/
 * public.yaml): no authentication (`security: []`, x-roles PUBLIC). downloadPublicFile and listPublicRegions live with
 * files and dictionaries.
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { currentIp } from '../../context.js';
import { ah } from '../../http/async.js';
import { publicService } from './service.js';

export function publicRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = publicService(c);

  r.get(
    '/public/batches/:publicCode',
    ah(async (req, res) => {
      const bytes = await svc.page(req.params.publicCode!);
      res.status(200).type('application/json; charset=utf-8').send(bytes);
    }),
  );
  r.post(
    '/public/batches/:publicCode/complaints',
    ah(async (req, res) => {
      res.status(201).json(await svc.complain(currentIp(), req.params.publicCode!, req.body));
    }),
  );
  r.get(
    '/public/captcha',
    ah(async (_req, res) => {
      res.status(200).set('Cache-Control', 'no-store').json(svc.captcha());
    }),
  );
  return r;
}
