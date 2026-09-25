/** /organizations/* (contracts/openapi/paths/organizations.yaml): HTTP mapping of the organizations service. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { readFileUpload } from '../../http/multipart.js';
import { idParam, variantParam } from '../../http/params.js';
import { CACHE_PRIVATE, sendFile } from '../files/download.js';
import { LOGO_MAX_BYTES, organizationsService } from './service.js';

export function organizationsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = organizationsService(c);

  r.get(
    '/organizations',
    guard(c, 'listOrganizations'),
    ah(async (req, res) => {
      res.status(200).json(await svc.directory(req.query));
    }),
  );
  r.get(
    '/organizations/:id',
    guard(c, 'getOrganization'),
    ah(async (req, res) => {
      res.status(200).json(await svc.get(principalOf(res), idParam(req)));
    }),
  );
  r.put(
    '/organizations/:id/logo',
    guard(c, 'uploadOrganizationLogo'),
    ah(async (req, res) => {
      const id = idParam(req);
      const upload = await readFileUpload(req, LOGO_MAX_BYTES);
      res.status(200).json(await svc.uploadLogo(principalOf(res), id, upload));
    }),
  );
  r.get(
    '/organizations/:id/logo',
    guard(c, 'getOrganizationLogo'),
    ah(async (req, res) => {
      const id = idParam(req);
      const variant = variantParam(req);
      const file = await svc.logoFile(principalOf(res), id);
      await sendFile(c, req, res, file, variant, CACHE_PRIVATE);
    }),
  );
  return r;
}
