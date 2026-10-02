/** /audit-log (contracts/openapi/paths/audit.yaml): the audit journal, read-only for ADMIN and INSPECTOR. */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { guard } from '../../http/auth.js';
import { listAuditLog } from './service.js';

export function auditRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get(
    '/audit-log',
    guard(c, 'listAuditLog'),
    ah(async (req, res) => {
      res.status(200).json(await listAuditLog(c.db, req.query));
    }),
  );
  return r;
}
