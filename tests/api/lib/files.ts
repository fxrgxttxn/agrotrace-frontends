/**
 * Files over HTTP (FR-FILE-01…05, R28/R34/R39/R88): multipart bodies, the committed fixtures, exact-size images for
 * the inclusive limits (Review Focus #5), WebP dimensions, the contract's Content-Disposition and signed-URL recipes.
 * Nothing here imports backend code or an image library: images are parsed by their headers only.
 *
 * Fixtures (tests/api/fixtures) were produced once with sharp from a synthetic gradient (never at test time):
 * landscape-640x320.png, portrait-300x600.jpg, alpha-200x100.webp (with alpha), tiny-40x20.png; the rest are
 * hand-written: logo-clean.svg, logo-hostile.svg (scripts, handlers, external references, foreignObject),
 * broken.svg (not well-formed), entities.svg (DTD entities), document.pdf, text-as-image.png (UTF-8 text under a
 * .png name), fake-signature.png (the PNG signature followed by text).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApiClient, ApiResponse } from './client.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 097 152 — avatars and logos (spec 8.6)
export const RASTER = ['image/jpeg', 'image/png', 'image/webp'];

export const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

export interface Part {
  name: string;
  /** Present → a file part (Content-Disposition filename). */
  filename?: string;
  /** The `filename` parameter exactly as written into the header (quoted-string escapes and all), instead of `filename`. */
  rawFilename?: string;
  contentType?: string;
  data: Buffer | string;
}

/** A multipart/form-data body (RFC 7578); the filename is sent as raw UTF-8, as browsers do. */
export function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----agrotrace${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.rawFilename !== undefined) head += `; filename=${p.rawFilename}`;
    else if (p.filename !== undefined) head += `; filename="${p.filename.replace(/"/g, '%22')}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`, 'utf8'), Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** PUT of one `file` part (plus optional extra parts) to an upload endpoint. */
export function upload(
  client: ApiClient,
  path: string,
  file: { data: Buffer | string; filename?: string; rawFilename?: string; contentType?: string },
  extra: Part[] = [],
): Promise<ApiResponse> {
  const { body, contentType } = multipart([
    {
      name: 'file',
      filename: file.filename ?? 'upload.bin',
      rawFilename: file.rawFilename,
      contentType: file.contentType ?? 'application/octet-stream',
      data: file.data,
    },
    ...extra,
  ]);
  return client.put(path, new Uint8Array(body), { headers: { 'content-type': contentType } });
}

// ── PNG of an exact size ─────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A valid PNG of exactly `total` bytes: tiny-40x20.png with a private ancillary chunk `apAd` of zero bytes inserted
 * before IEND (decoders skip unknown ancillary chunks; the CRC is correct), so "exactly the limit" and "limit + 1" are
 * real, decodable images.
 */
export function pngOfSize(total: number): Buffer {
  const base = fixture('tiny-40x20.png');
  const iend = base.length - 12; // IEND is the last chunk: length(4) type(4) crc(4), no data
  const pad = total - base.length - 12;
  if (pad < 0) throw new Error(`pngOfSize: ${total} is smaller than the base image`);
  const type = Buffer.from('apAd', 'ascii');
  const data = Buffer.alloc(pad);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(pad);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const out = Buffer.concat([base.subarray(0, iend), len, type, data, crc, base.subarray(iend)]);
  if (out.length !== total) throw new Error('pngOfSize: size mismatch');
  return out;
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Width and height of a WebP (simple lossy VP8, lossless VP8L or extended VP8X); throws if it is not WebP. */
export function webpSize(b: Buffer): { width: number; height: number } {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP')
    throw new Error('not a WebP file');
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  throw new Error(`unknown WebP chunk ${chunk}`);
}

// ── contract recipes ─────────────────────────────────────────────────────────────────────────────────────────────

export const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/**
 * `Content-Disposition` (components.headers.ContentDisposition, R34): `inline; filename="<ascii>";
 * filename*=UTF-8''<pct>`, name = base name of originalName without its extension + `.` + `ext`.
 */
export function contentDisposition(originalName: string, ext: string): string {
  const dot = originalName.lastIndexOf('.');
  const name = `${dot > 0 ? originalName.slice(0, dot) : originalName}.${ext}`;
  const ascii = [...name].map((c) => (/^[\x20-\x7e]$/.test(c) && c !== '"' && c !== '\\' ? c : '_')).join('');
  const pct = [...Buffer.from(name, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /^[A-Za-z0-9!#$&+\-.^_`|~]$/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
  return `inline; filename="${ascii}"; filename*=UTF-8''${pct}`;
}

/** The contract's signing recipe (downloadFile, R88 M2): hex HMAC(HMAC(JWT_SECRET, "agrotrace:file-url:v1"), "{id}:{exp}"). */
export function signature(id: string, exp: number, secret = process.env.JWT_SECRET!): string {
  const key = createHmac('sha256', secret).update('agrotrace:file-url:v1').digest();
  return createHmac('sha256', key).update(`${id.toLowerCase()}:${exp}`).digest('hex');
}

/** `/files/{id}?exp=…&sig=…` relative to API_URL (the `/api/v1` prefix stripped) of a SignedFileUrl. */
export const apiPath = (url: string): string => url.replace(/^\/api\/v1/, '');

/** The file id of a SignedFileUrl or PublicFileUrl. */
export const fileIdOf = (url: string): string =>
  /\/files\/([0-9a-f-]{36})/.exec(url)?.[1] ??
  (() => {
    throw new Error(`no file id in ${url}`);
  })();
