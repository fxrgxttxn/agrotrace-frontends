/**
 * GET /analytics/dashboard (paths/analytics.yaml) and GET /reports/{type} (paths/reports.yaml). The report file goes
 * out as an attachment named by the contract (ASCII only, so `filename` and `filename*` carry the same name),
 * `Cache-Control: no-store`.
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard, principalOf } from '../../http/auth.js';
import { dashboardService } from '../analytics/dashboard.js';
import { reportsService } from './service.js';
import { ReportAborted } from './render.js';

export function analyticsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const dashboards = dashboardService(c);
  const reports = reportsService(c);

  r.get(
    '/analytics/dashboard',
    guard(c, 'getDashboard'),
    ah(async (req, res) => {
      res.status(200).json(await dashboards.get(principalOf(res), req.query));
    }),
  );
  r.get(
    '/reports/:type',
    guard(c, 'downloadReport'),
    ah(async (req, res) => {
      // A client that goes away gives up its place in the render queue (modules/reports/render.ts).
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      let f;
      try {
        f = await reports.download(principalOf(res), req, abort.signal);
      } catch (err) {
        if (err instanceof ReportAborted) return;
        throw err;
      }
      res.status(200);
      res.setHeader('Content-Type', f.contentType);
      res.setHeader('Content-Length', String(f.bytes.length));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${f.fileName}"; filename*=UTF-8''${f.fileName}`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.end(f.bytes);
    }),
  );
  return r;
}
