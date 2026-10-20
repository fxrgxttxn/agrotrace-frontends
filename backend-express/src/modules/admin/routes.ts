/** /admin/organizations/* (contracts/openapi/paths/admin.yaml): HTTP mapping of the admin service. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idParam, isUuid } from '../../http/params.js';
import { AppProblem } from '../../http/problem.js';
import { adminService } from './service.js';

export function adminRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = adminService(c);

  r.get(
    '/admin/organizations',
    guard(c, 'listAdminOrganizations'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(req.query));
    }),
  );
  r.patch(
    '/admin/organizations/:id',
    guard(c, 'updateAdminOrganization'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.update(principalOf(res), id, req.body));
    }),
  );
  r.post(
    '/admin/organizations/:id/approve',
    guard(c, 'approveOrganization'),
    ah(async (req, res) => {
      // The operation declares no 400: a malformed id names no organization → 404.
      if (!isUuid(req.params.id)) throw new AppProblem(404, 'NOT_FOUND');
      res.status(200).json(await svc.approve(principalOf(res), req.params.id!.toLowerCase()));
    }),
  );
  return r;
}
