/**
 * Files (paths/files.yaml, public.yaml#downloadPublicFile, the image operations of users and organizations): the WebP
 * variant (`variant`, default 480) of a raster image, otherwise the stored file; `ETag` = sha256 of the served bytes,
 * `If-None-Match` → 304; `Content-Disposition` inline with the served type's extension; `Cache-Control` by access.
 * A signed URL grants access by its signature alone (403 when wrong or expired); Bearer access inherits the rights of
 * the entity the file belongs to (404 otherwise).
 */
import { contentDisposition, ifNoneMatch, liveFile, PUBLIC_KINDS, servedRepresentation, verifySignature } from '../domain/files.js';
import { canSeeBatch, canSeeLabTest, visibleBatchIds } from '../domain/visibility.js';
import type { Ctx, Handler } from '../http/context.js';
import { uuidParam } from '../http/params.js';
import { ApiError, notFound } from '../http/problem.js';
import type { FileRow, Principal } from '../store/types.js';

export const CACHE_PRIVATE = 'private, max-age=0, must-revalidate';
export const CACHE_PUBLIC = 'public, max-age=86400';

export async function sendFile(ctx: Ctx, f: FileRow, variant: 96 | 480, cache: string, disposition?: string): Promise<Response> {
  const served = servedRepresentation(ctx.cfg, f, variant);
  const etag = `"${served.sha256}"`;
  if (ifNoneMatch(ctx.request.headers.get('If-None-Match'), etag))
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cache } });
  const bytes = await served.bytes();
  return new Response(ctx.request.method === 'HEAD' ? null : bytes, {
    status: 200,
    headers: {
      'Content-Type': served.mime,
      'Content-Length': String(bytes.length),
      'Content-Disposition': disposition ?? contentDisposition(f.original_name, served.mime),
      ETag: etag,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** An image of an entity (avatar, logo): 404 when there is none. */
export function imageResponse(ctx: Ctx, fileId: string | null, variant: 96 | 480, access: 'private' | 'public'): Promise<Response> {
  const f = liveFile(ctx.store, fileId);
  if (!f) throw notFound();
  return sendFile(ctx, f, variant, access === 'public' ? CACHE_PUBLIC : CACHE_PRIVATE);
}

function variantOf(ctx: Ctx): 96 | 480 {
  return ctx.url.searchParams.get('variant') === '96' ? 96 : 480;
}

/** Bearer access to a file: the rights of the entity it belongs to (п. 4.2). */
function canRead(ctx: Ctx, p: Principal, f: FileRow): boolean {
  const s = ctx.store;
  switch (f.kind) {
    case 'AVATAR':
    case 'LOGO':
    case 'PRODUCT_IMAGE':
      return true;
    case 'REPORT':
      return f.owner_id === p.userId;
    case 'LAB_PROTOCOL': {
      const batches = visibleBatchIds(s, p);
      return s.t.lab_tests.some((t) => t.protocol_file_id === f.id && canSeeLabTest(s, p, t, batches));
    }
    case 'QR':
      return s.t.batches.some((b) => (b.qr_png_file_id === f.id || b.qr_pdf_file_id === f.id) && canSeeBatch(s, p, b));
  }
}

export const filesHandlers: Record<string, Handler> = {
  downloadFile(ctx) {
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    q.enumOf('variant', ['96', '480'] as const);
    const hasExp = q.has('exp');
    const hasSig = q.has('sig');
    const exp = q.int('exp', 0, null);
    const sig = q.matching('sig', /^[0-9a-f]{64}$/);
    q.done();
    const f = liveFile(ctx.store, id);
    if (hasExp || hasSig) {
      if (!hasExp || !hasSig || !verifySignature(ctx.cfg, id, exp!, sig!))
        throw new ApiError(403, 'FORBIDDEN', { title: 'Invalid or expired signature' });
      if (!f) throw notFound();
    } else if (!f || !canRead(ctx, ctx.user(), f)) throw notFound();
    return sendFile(ctx, f!, variantOf(ctx), CACHE_PRIVATE);
  },

  downloadPublicFile(ctx) {
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    q.enumOf('variant', ['96', '480'] as const);
    q.done();
    const f = liveFile(ctx.store, id);
    if (!f || !PUBLIC_KINDS.includes(f.kind)) throw notFound();
    return sendFile(ctx, f, variantOf(ctx), CACHE_PUBLIC);
  },
};
