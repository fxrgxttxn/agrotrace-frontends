import { hex, hmacSha256, sha256hex, timingSafeEqualHex } from '../lib/crypto.js';
import type { MockConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { FileKind, FileRow } from '../store/types.js';

export const SIGNED_URL_TTL_SEC = 3600;
export const PUBLIC_KINDS: readonly FileKind[] = ['LOGO', 'PRODUCT_IMAGE'];

const fileUrlKey = (secret: string): Uint8Array => hmacSha256(secret, 'agrotrace:file-url:v1');

export function fileSignature(secret: string, id: string, exp: number): string {
  return hex(hmacSha256(fileUrlKey(secret), `${id.toLowerCase()}:${exp}`));
}

export function signedUrl(cfg: MockConfig, id: string): string {
  const exp = Math.floor(cfg.now() / 1000) + SIGNED_URL_TTL_SEC;
  return `/api/v1/files/${id.toLowerCase()}?exp=${exp}&sig=${fileSignature(cfg.secret, id, exp)}`;
}

export function verifySignature(cfg: MockConfig, id: string, exp: number, sig: string): boolean {
  if (!Number.isSafeInteger(exp) || exp < Math.floor(cfg.now() / 1000)) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqualHex(fileSignature(cfg.secret, id, exp), sig);
}

export const publicFileUrl = (id: string): string => `/api/v1/public/files/${id.toLowerCase()}`;

export function fileUrl(cfg: MockConfig, f: Pick<FileRow, 'id' | 'kind'>): string {
  return PUBLIC_KINDS.includes(f.kind) ? publicFileUrl(f.id) : signedUrl(cfg, f.id);
}

export interface FileRef {
  id: string;
  url: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

export function fileRef(cfg: MockConfig, f: FileRow): FileRef {
  return { id: f.id, url: fileUrl(cfg, f), mime: f.mime, sizeBytes: f.size_bytes, originalName: f.original_name };
}

export function liveFile(store: Store, id: string | null | undefined): FileRow | undefined {
  const f = store.get('files', id);
  return f && f.deleted_at === null ? f : undefined;
}

export function insertBytesFile(
  store: Store,
  a: {
    kind: FileKind;
    originalName: string;
    mime: string;
    data: Uint8Array;
    ownerId: string | null;
    variants?: Record<string, Uint8Array>;
  },
): FileRow {
  const variants: FileRow['variants'] = {};
  for (const [size, bytes] of Object.entries(a.variants ?? {}))
    variants[size] = { sha256: sha256hex(bytes), size: bytes.length };
  const row: FileRow = {
    id: store.id('file'),
    kind: a.kind,
    original_name: a.originalName,
    mime: a.mime,
    size_bytes: a.data.length,
    sha256: sha256hex(a.data),
    variants,
    owner_id: a.ownerId,
    created_at: store.nowIso(),
    deleted_at: null,
    content: { type: 'bytes', data: a.data, ...(a.variants && { variants: a.variants }) },
  };
  store.insert('files', row);
  store.created('file', row);
  return row;
}

export function softDeleteFile(store: Store, id: string | null): void {
  const f = liveFile(store, id);
  if (!f) return;
  store.touch('file', f);
  store.patch(f, { deleted_at: store.nowIso() });
}

export interface Served {
  mime: string;
  sha256: string;
  size: number;
  bytes: () => Promise<Uint8Array>;
}

async function blobOf(cfg: MockConfig, key: string): Promise<Uint8Array> {
  const b = await cfg.blobs?.get(key);
  if (!b) throw new Error(`file bytes ${key} are missing from the blob store`);
  return b;
}

export function servedRepresentation(cfg: MockConfig, f: FileRow, variant: 96 | 480): Served {
  const v = f.variants[String(variant)];
  const c = f.content;
  if (v) {
    return {
      mime: 'image/webp',
      sha256: v.sha256,
      size: v.size,
      bytes: async () =>
        c.type === 'bytes'
          ? c.variants![String(variant)]!
          : c.type === 'blob'
            ? blobOf(cfg, `${f.id}:${variant}`)
            : cfg.loadAsset(c.variants![String(variant)]!),
    };
  }
  return {
    mime: f.mime,
    sha256: f.sha256,
    size: f.size_bytes,
    bytes: async () => (c.type === 'bytes' ? c.data : c.type === 'blob' ? blobOf(cfg, f.id) : cfg.loadAsset(c.url!)),
  };
}

const EXTENSION: Record<string, string> = {
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

export function contentDisposition(originalName: string, mime: string): string {
  const ext = EXTENSION[mime] ?? 'bin';
  const dot = originalName.lastIndexOf('.');
  const name = `${dot > 0 ? originalName.slice(0, dot) : originalName}.${ext}`;
  const ascii = [...name]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x20 && cp <= 0x7e && ch !== '"' && ch !== '\\' ? ch : '_';
    })
    .join('');
  const pct = [...new TextEncoder().encode(name)]
    .map((b) => {
      const ch = String.fromCharCode(b);
      return ATTR_CHAR.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
  return `inline; filename="${ascii}"; filename*=UTF-8''${pct}`;
}

export function ifNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || t.replace(/^W\//, '') === bare);
}

export function sniff(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  const ascii = (s: number, e: number): string => String.fromCharCode(...b.subarray(s, e));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (!b.includes(0)) {
    let s = new TextDecoder().decode(b.subarray(0, 4096));
    if (s.startsWith('﻿')) s = s.slice(1);
    const prolog = /^(\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>)/i;
    for (let m = prolog.exec(s); m; m = prolog.exec(s)) s = s.slice(m[0].length);
    if (/^<svg[\s>/]/.test(s)) return 'image/svg+xml';
  }
  return null;
}
