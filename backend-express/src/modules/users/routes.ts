/** /users/* (contracts/openapi/paths/users.yaml): HTTP mapping of the users service and getUserAvatar. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { idParam, variantParam } from '../../http/params.js';
import { AppProblem } from '../../http/problem.js';
import { CACHE_PRIVATE, sendFile } from '../files/download.js';
import { usersService } from './service.js';

export function usersRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = usersService(c);

  r.get(
    '/users',
    guard(c, 'listUsers'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/users',
    guard(c, 'inviteUser'),
    ah(async (req, res) => {
      res.status(201).json(await svc.invite(principalOf(res), req.body));
    }),
  );
  r.patch(
    '/users/:id',
    guard(c, 'updateUser'),
    ah(async (req, res) => {
      const id = idParam(req);
      res.status(200).json(await svc.update(principalOf(res), id, req.body));
    }),
  );
  /** getUserAvatar — any authenticated user (п. 4.2); no user, no avatar → 404. */
  r.get(
    '/users/:id/avatar',
    guard(c, 'getUserAvatar'),
    ah(async (req, res) => {
      const id = idParam(req);
      const variant = variantParam(req);
      const file = await c.db
        .selectFrom('users as u')
        .innerJoin('files as f', 'f.id', 'u.avatar_file_id')
        .selectAll('f')
        .where('u.id', '=', id)
        .where('u.deleted_at', 'is', null)
        .where('f.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!file) throw new AppProblem(404, 'NOT_FOUND');
      await sendFile(c, req, res, file, variant, CACHE_PRIVATE);
    }),
  );
  return r;
}
