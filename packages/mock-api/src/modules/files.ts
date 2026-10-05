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
      ...(served.mime === 'image/svg+xml' && { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }),
    },
  });
}

export function imageResponse(ctx: Ctx, fileId: string | null, variant: 96 | 480, access: 'private' | 'public'): Promise<Response> {
  const f = liveFile(ctx.store, fileId);
  if (!f) throw notFound();
  return sendFile(ctx, f, variant, access === 'public' ? CACHE_PUBLIC : CACHE_PRIVATE);
}

function variantOf(ctx: Ctx): 96 | 480 {
  return ctx.url.searchParams.get('variant') === '96' ? 96 : 480;
}

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
    const sp = ctx.url.searchParams;
    const signed = sp.has('exp') || sp.has('sig');
    if (signed) {
      const exps = sp.getAll('exp');
      const sigs = sp.getAll('sig');
      const rawId = (ctx.params.id ?? '').toLowerCase();
      const ok =
        exps.length === 1 &&
        sigs.length === 1 &&
        /^[1-9]\d{0,11}$/.test(exps[0]!) &&
        /^[0-9a-f]{64}$/.test(sigs[0]!) &&
        verifySignature(ctx.cfg, rawId, Number(exps[0]), sigs[0]!);
      if (!ok) throw new ApiError(403, 'FORBIDDEN', { title: 'Invalid or expired signature' });
    }
    const id = uuidParam(ctx.params.id);
    const q = ctx.query();
    q.enumOf('variant', ['96', '480'] as const);
    q.done();
    const f = liveFile(ctx.store, id);
    if (!f || (!signed && !canRead(ctx, ctx.user(), f))) throw notFound();
    return sendFile(ctx, f, variantOf(ctx), CACHE_PRIVATE);
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
