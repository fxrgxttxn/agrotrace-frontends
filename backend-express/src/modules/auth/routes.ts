/**
 * /auth/* (contracts/openapi/paths/auth.yaml): HTTP mapping of the auth service — cookies (`at_refresh`, R32/R40),
 * statuses, `Cache-Control: no-store` on every response that carries a token.
 */
import { Router, type Response } from 'express';
import type { Container } from '../../container.js';
import { currentIp } from '../../context.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { AppProblem, sendProblem } from '../../http/problem.js';
import { authService, type Session } from './service.js';
import { CLEAR_REFRESH_COOKIE, refreshCookieOf, revokeRefreshToken, setRefreshCookie } from './sessions.js';

function sendSession(res: Response, s: Session): void {
  res.setHeader('Set-Cookie', setRefreshCookie(s.refreshToken));
  res.setHeader('Cache-Control', 'no-store');
  res
    .status(200)
    .json({ twoFactorRequired: false, accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user });
}

export function authRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const auth = authService(c);

  r.post(
    '/login',
    ah(async (req, res) => {
      const result = await auth.login(currentIp(), req.body);
      if (result.twoFactorRequired) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ twoFactorRequired: true, challengeId: result.challengeId });
        return;
      }
      sendSession(res, result);
    }),
  );

  r.post(
    '/2fa/verify',
    ah(async (req, res) => {
      sendSession(res, await auth.verifyTwoFactor(req.body));
    }),
  );

  r.post(
    '/2fa/setup',
    guard(c, 'setupTwoFactor'),
    ah(async (req, res) => {
      const result = await auth.setupTwoFactor(principalOf(res), req.body);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    }),
  );

  r.post(
    '/refresh',
    ah(async (req, res) => {
      const outcome = await auth.refresh(refreshCookieOf(req.headers.cookie));
      switch (outcome.kind) {
        case 'rotated':
          res.setHeader('Set-Cookie', setRefreshCookie(outcome.token));
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json({ accessToken: await auth.accessTokenFor(outcome.userId), expiresIn: 900 });
          return;
        case 'expired':
          if (outcome.clearCookie) res.setHeader('Set-Cookie', CLEAR_REFRESH_COOKIE);
          sendProblem(res, new AppProblem(401, 'TOKEN_EXPIRED', { title: 'Refresh token expired' }));
          return;
        case 'forbidden':
          res.setHeader('Set-Cookie', CLEAR_REFRESH_COOKIE);
          sendProblem(res, new AppProblem(403, 'FORBIDDEN', { params: { reason: outcome.reason } }));
          return;
      }
    }),
  );

  r.post(
    '/logout',
    ah(async (req, res) => {
      await revokeRefreshToken(c.db, refreshCookieOf(req.headers.cookie));
      res.setHeader('Set-Cookie', CLEAR_REFRESH_COOKIE);
      res.status(204).end();
    }),
  );

  r.post(
    '/password/forgot',
    ah(async (req, res) => {
      await auth.forgotPassword(req.body);
      res.status(204).end();
    }),
  );

  r.post(
    '/password/reset',
    ah(async (req, res) => {
      await auth.resetPassword(req.body);
      res.status(204).end();
    }),
  );

  r.post(
    '/register-organization',
    ah(async (req, res) => {
      res.status(201).json(await auth.registerOrganization(req.body));
    }),
  );

  r.post(
    '/accept-invite',
    ah(async (req, res) => {
      await auth.acceptInvite(req.body);
      res.status(204).end();
    }),
  );

  return r;
}
