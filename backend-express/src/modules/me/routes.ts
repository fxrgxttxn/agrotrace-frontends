/** /me/* (contracts/openapi/paths/me.yaml): HTTP mapping of the profile service. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { readFileUpload } from '../../http/multipart.js';
import { AVATAR_MAX_BYTES, meService } from './service.js';

export function meRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = meService(c);

  r.get(
    '/me',
    guard(c, 'getMe'),
    ah(async (_req, res) => {
      res.status(200).json(await svc.getMe(principalOf(res)));
    }),
  );
  r.patch(
    '/me',
    guard(c, 'updateMe'),
    ah(async (req, res) => {
      res.status(200).json(await svc.updateMe(principalOf(res), req.body));
    }),
  );
  r.put(
    '/me/avatar',
    guard(c, 'uploadMyAvatar'),
    ah(async (req, res) => {
      const upload = await readFileUpload(req, AVATAR_MAX_BYTES);
      res.status(200).json(await svc.uploadAvatar(principalOf(res), upload));
    }),
  );
  r.delete(
    '/me/avatar',
    guard(c, 'deleteMyAvatar'),
    ah(async (_req, res) => {
      await svc.deleteAvatar(principalOf(res));
      res.status(204).end();
    }),
  );
  r.get(
    '/me/channels',
    guard(c, 'getMyChannels'),
    ah(async (_req, res) => {
      res.status(200).json(await svc.getChannels(principalOf(res)));
    }),
  );
  r.put(
    '/me/channels',
    guard(c, 'updateMyChannels'),
    ah(async (req, res) => {
      res.status(200).json(await svc.updateChannels(principalOf(res), req.body));
    }),
  );
  r.post(
    '/me/telegram-code',
    guard(c, 'createTelegramCode'),
    ah(async (_req, res) => {
      res.status(201).json(await svc.createTelegramCode(principalOf(res)));
    }),
  );
  return r;
}
