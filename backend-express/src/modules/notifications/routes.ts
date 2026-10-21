/**
 * /notifications, /notifications/read (contracts/openapi/paths/notifications.yaml) and /events/stream (paths/events.yaml).
 *
 * streamEvents authenticates with the `access_token` query parameter (EventSource cannot send headers; the
 * `Authorization` header is not used): an invalid token → 401 problem before the stream starts; then the `user` rate
 * limit (R30, every Bearer-authenticated request) — x-roles ANY. `Last-Event-ID` wins over `lastEventId`; a value
 * that is not a sequence number (`^\d+$`, at most 18 digits) is treated as absent (the operation declares no 400).
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { AppProblem } from '../../http/problem.js';
import { hitRateLimit } from '../../http/rate-limit.js';
import { verifyAccessTokenExp } from '../../security/jwt.js';
import { notificationsService } from './service.js';

const SEQ = /^\d{1,18}$/;

export function notificationsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const svc = notificationsService(c);

  r.get(
    '/notifications',
    guard(c, 'listNotifications'),
    ah(async (req, res) => {
      res.status(200).json(await svc.list(principalOf(res), req.query));
    }),
  );
  r.post(
    '/notifications/read',
    guard(c, 'markNotificationsRead'),
    ah(async (req, res) => {
      res.status(200).json(await svc.markRead(principalOf(res), req.body));
    }),
  );
  r.get(
    '/events/stream',
    ah(async (req, res) => {
      const token = typeof req.query.access_token === 'string' ? req.query.access_token : '';
      const verified = token ? await verifyAccessTokenExp(c.config.JWT_SECRET, token) : null;
      if (!verified) throw new AppProblem(401, 'UNAUTHORIZED');
      await hitRateLimit(c.redis, 'user', verified.principal.userId, c.config.RATE_LIMIT_OVERRIDES);
      if (!c.sse) throw new Error('streamEvents: no SSE hub in this process');
      const header = req.headers['last-event-id'];
      const query = req.query.lastEventId;
      const raw = typeof header === 'string' ? header : typeof query === 'string' ? query : undefined;
      const lastSeq = raw !== undefined && SEQ.test(raw) ? raw : null;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // The gateway must not buffer the stream (nginx honours this header).
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      req.socket.setNoDelay(true);
      try {
        await c.sse.open(res, { userId: verified.principal.userId, exp: verified.exp, lastSeq });
      } catch (err) {
        // The stream has started: no problem document can follow — log and end it (the client reconnects).
        c.logger.error({ err }, 'sse stream setup failed');
        res.end();
      }
    }),
  );
  return r;
}
