/**
 * downloadFile (`GET /files/{id}`) and downloadPublicFile (`GET /public/files/{id}`), contracts/openapi/paths/files.yaml
 * and public.yaml.
 *
 * downloadFile (x-access: signed), in this order:
 * 1. a valid Bearer token counts against the `user` limit — also when a signature is present;
 * 2. `exp` or `sig` present → only the signature decides: both must be there, `exp` not in the past and `sig` the
 *    contract's HMAC (constant-time) — otherwise 403 FORBIDDEN; rights are not checked, Authorization is ignored;
 * 3. no signature → a valid Bearer token or 401;
 * 4. 400 for `id` / `variant`; 5. a missing, deleted or (Bearer) unreadable file → 404.
 */
import { Router } from 'express';
import type { Container } from '../../container.js';
import { ah } from '../../http/async.js';
import { bearerPrincipal } from '../../http/auth.js';
import { idParam, variantParam } from '../../http/params.js';
import { AppProblem } from '../../http/problem.js';
import { hitRateLimit } from '../../http/rate-limit.js';
import { canReadFile } from './access.js';
import { CACHE_PRIVATE, CACHE_PUBLIC, sendFile } from './download.js';
import { PUBLIC_KINDS, type FileRow } from './service.js';

const badSignature = () => new AppProblem(403, 'FORBIDDEN', { title: 'Invalid or expired signature' });

async function liveFile(c: Container, id: string): Promise<FileRow | null> {
  return (
    (await c.db
      .selectFrom('files')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()) ?? null
  );
}

export function filesRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get(
    '/files/:id',
    ah(async (req, res) => {
      const principal = await bearerPrincipal(c, req);
      if (principal) await hitRateLimit(c.redis, 'user', principal.userId, c.config.RATE_LIMIT_OVERRIDES);
      const { exp, sig } = req.query;
      const signed = exp !== undefined || sig !== undefined;
      if (signed) {
        if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp))
          throw badSignature();
        if (!c.fileUrls.verify(String(req.params.id ?? ''), Number(exp), sig)) throw badSignature();
      } else if (!principal) {
        throw new AppProblem(401, 'UNAUTHORIZED');
      }
      const id = idParam(req);
      const variant = variantParam(req);
      const file = await liveFile(c, id);
      if (!file || (!signed && !(await canReadFile(c.db, principal!, file))))
        throw new AppProblem(404, 'NOT_FOUND');
      await sendFile(c, req, res, file, variant, CACHE_PRIVATE);
    }),
  );
  return r;
}

export function publicFilesRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  r.get(
    '/public/files/:id',
    ah(async (req, res) => {
      const id = idParam(req);
      const variant = variantParam(req);
      const file = await liveFile(c, id);
      if (!file || !(PUBLIC_KINDS as readonly string[]).includes(file.kind))
        throw new AppProblem(404, 'NOT_FOUND');
      await sendFile(c, req, res, file, variant, CACHE_PUBLIC);
    }),
  );
  return r;
}
