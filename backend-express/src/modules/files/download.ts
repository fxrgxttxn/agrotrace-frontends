/**
 * Streaming a stored file (FR-FILE-03, components.responses FileContent / ImageContent / PublicImageContent, R34):
 * the WebP variant (`variant`, default 480) of a raster image, otherwise the stored file itself (SVG, PDF, PNG QR…).
 * `ETag` = `"` + sha256 of the served bytes + `"` (taken from `files.variants` / `files.sha256`, so every backend
 * sends the same tag); `If-None-Match` (strong or weak form, a list or `*`) → 304 without a body; `Content-Disposition`
 * `inline; filename="<ascii>"; filename*=UTF-8''<pct>` with the served type's extension; `Cache-Control` by access.
 */
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { Container } from '../../container.js';
import type { FileRow, VariantMeta } from './service.js';

export const CACHE_PRIVATE = 'private, max-age=0, must-revalidate';
export const CACHE_PUBLIC = 'public, max-age=86400';

const EXTENSION: Record<string, string> = {
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** RFC 5987 `attr-char`: ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~". */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/** components.headers.ContentDisposition: name = originalName without its extension + `.` + the served extension. */
export function contentDisposition(originalName: string, ext: string): string {
  const dot = originalName.lastIndexOf('.');
  const name = `${dot > 0 ? originalName.slice(0, dot) : originalName}.${ext}`;
  const ascii = [...name]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x20 && cp <= 0x7e && ch !== '"' && ch !== '\\' ? ch : '_';
    })
    .join('');
  const pct = [...Buffer.from(name, 'utf8')]
    .map((b) => {
      const ch = String.fromCharCode(b);
      return ATTR_CHAR.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
  return `inline; filename="${ascii}"; filename*=UTF-8''${pct}`;
}

/** RFC 9110 If-None-Match: weak comparison against any listed tag, `*` matches any current representation. */
export function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || t.replace(/^W\//, '') === bare);
}

interface Served {
  key: string;
  sha256: string;
  size: number;
  mime: string;
}

export function servedRepresentation(file: FileRow, variant: 96 | 480): Served {
  const variants = (file.variants ?? {}) as unknown as Record<string, VariantMeta>;
  const v = variants[String(variant)];
  if (v) return { key: v.key, sha256: v.sha256, size: Number(v.size), mime: 'image/webp' };
  return { key: file.object_key, sha256: file.sha256, size: Number(file.size_bytes), mime: file.mime };
}

export async function sendFile(
  c: Container,
  req: Request,
  res: Response,
  file: FileRow,
  variant: 96 | 480,
  cacheControl: string,
  /** Overrides the default `Content-Disposition` (downloadBatchQr: exactly `inline; filename="{publicCode}.png"`). */
  disposition?: string,
): Promise<void> {
  const served = servedRepresentation(file, variant);
  const etag = `"${served.sha256}"`;
  if (ifNoneMatch(req.headers['if-none-match'], etag)) {
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', cacheControl);
    res.status(304).end();
    return;
  }
  // Fetched before any header is set: a storage failure is still a clean problem response.
  const body = await c.s3.get(served.key);
  res.status(200);
  res.setHeader('Content-Type', served.mime);
  res.setHeader('Content-Length', String(served.size));
  res.setHeader(
    'Content-Disposition',
    disposition ?? contentDisposition(file.original_name, EXTENSION[served.mime] ?? 'bin'),
  );
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Defence in depth for SVG opened directly: no script, no external loads (the document is sanitized anyway).
  if (served.mime === 'image/svg+xml')
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }
  try {
    await pipeline(body, res);
  } catch (err) {
    // The client went away or the storage stream broke after the headers: the connection can only be closed.
    c.logger.debug({ err: (err as Error).message, file: file.id }, 'file stream ended early');
    res.destroy();
  }
}
