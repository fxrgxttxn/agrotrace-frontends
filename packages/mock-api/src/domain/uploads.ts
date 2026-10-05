import { codePointLength } from '@agrotrace/validation';
import type { Ctx } from '../http/context.js';
import { ApiError, validation } from '../http/problem.js';
import { sniff } from './files.js';
import { sanitizeSvg } from './svg.js';

export const RASTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface Upload {
  name: string;
  mime: string;
  bytes: Uint8Array;
  variants?: Record<string, Uint8Array>;
}

export const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? '';

async function formOf(ctx: Ctx): Promise<FormData> {
  const type = ctx.request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) throw validation({ file: ['validation.required'] });
  try {
    return await ctx.request.formData();
  } catch {
    throw validation({ _root: ['validation.invalid'] });
  }
}

export async function readFilePart(ctx: Ctx, maxBytes: number): Promise<File> {
  const form = await formOf(ctx);
  const errors: Record<string, string[]> = {};
  for (const k of new Set(form.keys())) if (k !== 'file') errors[k] = ['validation.unknownField'];
  const parts = form.getAll('file');
  const file = parts[0];
  if (file === undefined || typeof file === 'string' || file.size === 0) errors.file = ['validation.required'];
  else if (parts.length > 1) errors.file = ['validation.duplicate'];
  else if (codePointLength(baseName(file.name || 'file')) > 255) errors.file = ['validation.maxLength'];
  if (Object.keys(errors).length > 0) throw validation(errors);
  const f = file as File;
  if (f.size > maxBytes) throw new ApiError(413, 'FILE_TOO_LARGE', { params: { maxBytes } });
  return f;
}

export async function readUpload(
  ctx: Ctx,
  maxBytes: number,
  allowed: readonly string[],
  entity: () => void = () => undefined,
): Promise<Upload> {
  const f = await readFilePart(ctx, maxBytes);
  entity();
  const bytes = new Uint8Array(await f.arrayBuffer());
  const unsupported = (reason?: string) =>
    new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: [...allowed], ...(reason && { reason }) } });
  const mime = sniff(bytes);
  if (mime === null || !allowed.includes(mime)) throw unsupported();
  const name = baseName(f.name || 'file') || 'file';
  if (mime === 'image/svg+xml') {
    const clean = sanitizeSvg(bytes);
    if (!clean.ok) throw unsupported(clean.tooComplex ? 'svg-too-complex' : undefined);
    return { name, mime, bytes: new TextEncoder().encode(clean.svg) };
  }
  if (RASTER_TYPES.includes(mime)) {
    const variants = await rasterVariants(bytes, mime);
    if (variants === null) throw unsupported();
    return { name, mime, bytes, ...(variants && { variants }) };
  }
  return { name, mime, bytes };
}

interface Canvasish {
  getContext(type: '2d'): { drawImage(img: unknown, x: number, y: number, w: number, h: number): void } | null;
  convertToBlob(o: { type: string; quality: number }): Promise<Blob>;
}

export async function rasterVariants(bytes: Uint8Array, mime: string): Promise<Record<string, Uint8Array> | undefined | null> {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => Canvasish;
    createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close(): void }>;
  };
  if (!g.OffscreenCanvas || !g.createImageBitmap) return undefined;
  let bitmap: { width: number; height: number; close(): void };
  try {
    bitmap = await g.createImageBitmap(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
  if (bitmap.width * bitmap.height > 40_000_000) return null;
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
}
