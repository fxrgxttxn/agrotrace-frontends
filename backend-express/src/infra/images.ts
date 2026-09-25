/**
 * Uploaded file types and the image pipeline (FR-FILE-02, FR-FILE-04, spec 8.6).
 *
 * The type is decided by the content only (magic bytes), never by the file name or the part's Content-Type:
 * JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF????WEBP`, PDF `%PDF-`, SVG — UTF-8 text whose first
 * element (after an optional BOM, XML declaration, comments and doctype) is `<svg`. Raster images become WebP
 * variants of 96 and 480 px on the longer side (sharp, auto-rotated by EXIF, never enlarged — the seed's rule), each
 * stored with its own sha256 and size (`files.variants`, R34).
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml' | 'application/pdf';

export const RASTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const IMAGE_VARIANTS = [96, 480] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** SVG: after the prolog (BOM, `<?xml … ?>`, comments, `<!DOCTYPE …>`, whitespace) the root element is `svg`. */
function looksLikeSvg(b: Buffer): boolean {
  if (b.includes(0)) return false; // binary
  let s = b.subarray(0, 4096).toString('utf8');
  if (s.startsWith('﻿')) s = s.slice(1);
  const prolog = /^(\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>)/i;
  for (let m = prolog.exec(s); m; m = prolog.exec(s)) s = s.slice(m[0].length);
  return /^<svg[\s>/]/.test(s);
}

export function sniff(b: Buffer): SniffedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (looksLikeSvg(b)) return 'image/svg+xml';
  return null;
}

export const sha256hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface StoredVariant {
  body: Buffer;
  sha256: string;
  size: number;
}

/** Decoding limits: a 2 MiB upload cannot become a decompression bomb (about 40 megapixels at most). */
const SHARP_INPUT = { limitInputPixels: 40_000_000, failOn: 'error' } as const;

const SHARP_FORMAT: Record<(typeof RASTER_TYPES)[number], string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * WebP 96 and 480 of a raster image whose signature said `mime`; null when the content does not decode as that
 * format (a forged signature, a truncated or oversized image) — the caller answers 415.
 */
export async function rasterVariants(
  bytes: Buffer,
  mime: (typeof RASTER_TYPES)[number],
): Promise<Record<ImageVariant, StoredVariant> | null> {
  try {
    const meta = await sharp(bytes, SHARP_INPUT).metadata();
    if (meta.format !== SHARP_FORMAT[mime] || !meta.width || !meta.height) return null;
    const out = {} as Record<ImageVariant, StoredVariant>;
    for (const size of IMAGE_VARIANTS) {
      const body = await sharp(bytes, SHARP_INPUT)
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      out[size] = { body, sha256: sha256hex(body), size: body.length };
    }
    return out;
  } catch {
    return null;
  }
}
