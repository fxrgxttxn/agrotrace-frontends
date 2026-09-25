/**
 * Multipart uploads (п. 8.6): the `file` field (missing → 400 `errors.file: [validation.required]`), the size limit
 * (inclusive, → 413 FILE_TOO_LARGE `{maxBytes}`), the type by signature (→ 415 `{allowed}`). Raster images get their
 * WebP 96/480 variants from the browser's canvas (OffscreenCanvas + createImageBitmap) when it can encode WebP;
 * otherwise (Node, Safari) the original is served as is. SVG logos are stripped of scripts, event handlers and
 * external references (a regular-expression sanitizer, not DOMPurify).
 */
import type { Ctx } from '../http/context.js';
import { ApiError, validation } from '../http/problem.js';
import { sniff } from './files.js';

export const RASTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface Upload {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export async function readUpload(ctx: Ctx, maxBytes: number, allowed: readonly string[]): Promise<Upload> {
  const form = await ctx.form();
  const file = form.get('file');
  const extra = [...form.keys()].filter((k) => k !== 'file');
  if (extra.length > 0) throw validation(Object.fromEntries(extra.map((k) => [k, ['validation.unknownField']])));
  if (file === null || typeof file === 'string') throw validation({ file: ['validation.required'] });
  if (file.size > maxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', { params: { maxBytes } });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (mime === null || !allowed.includes(mime))
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: [...allowed] } });
  const name = (file as File).name || 'file';
  return { name: name.split(/[\\/]/).pop() || 'file', mime, bytes: mime === 'image/svg+xml' ? sanitizeSvg(bytes) : bytes };
}

export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  let s = new TextDecoder().decode(bytes);
  s = s
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
  return new TextEncoder().encode(s);
}

/** WebP 96 and 480 px on the longer side (never enlarged), or undefined when the runtime cannot encode WebP. */
export async function rasterVariants(bytes: Uint8Array, mime: string): Promise<Record<string, Uint8Array> | undefined> {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => {
      getContext(type: '2d'): { drawImage(img: unknown, x: number, y: number, w: number, h: number): void } | null;
      convertToBlob(o: { type: string; quality: number }): Promise<Blob>;
    };
    createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close(): void }>;
  };
  if (!g.OffscreenCanvas || !g.createImageBitmap) return undefined;
  try {
    const bitmap = await g.createImageBitmap(new Blob([bytes], { type: mime }));
    const out: Record<string, Uint8Array> = {};
    for (const size of [96, 480]) {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new g.OffscreenCanvas(w, h);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
      if (blob.type !== 'image/webp') return undefined;
      out[String(size)] = new Uint8Array(await blob.arrayBuffer());
    }
    bitmap.close();
    return out;
  } catch {
    // Not decodable as an image: the signature was forged.
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: RASTER_TYPES } });
  }
}
