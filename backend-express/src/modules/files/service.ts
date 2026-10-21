/**
 * Stored files (FR-FILE-01…05, spec 8.6, R34): the `files` row, its MinIO objects and the contract's `FileRef`.
 *
 * Object keys: `{type}/{yyyy}/{mm}/{fileId}/{variant}` (spec 8.6), the upload itself under `original`, the WebP
 * variants under `96` and `480`; `files.variants` = `{"96": {key, sha256, size}, "480": {…}}` (the seed's layout).
 * An SVG logo is stored after sanitization — the sanitized document is the file (`size_bytes`, `sha256`), so the
 * served bytes, their ETag and `FileRef.sizeBytes` agree.
 *
 * Logos and product photos are public (`/api/v1/public/files/{id}`); every other kind is served through a signed URL
 * (R28 as amended by R34, R39, R88 M2).
 */
import { randomUUID } from 'node:crypto';
import type { Insertable, Selectable, Transaction } from 'kysely';
import type { DB, Files } from '../../db/types.generated.js';
import { AppProblem } from '../../http/problem.js';
import type { UploadedFile } from '../../http/multipart.js';
import { txNow } from '../../db/tx.js';
import { publicFileUrl, type FileUrls } from '../../infra/file-urls.js';
import { RASTER_TYPES, rasterVariants, sha256hex, sniff, type SniffedType } from '../../infra/images.js';
import type { S3 } from '../../infra/s3.js';
import { sanitizeSvg } from '../../infra/svg.js';

export type FileKind = 'AVATAR' | 'LOGO' | 'PRODUCT_IMAGE' | 'LAB_PROTOCOL' | 'QR' | 'REPORT';
export type FileRow = Selectable<Files>;

/** Files readable by anyone without authorization (п. 4.2: product photos and organization logos). */
export const PUBLIC_KINDS: readonly FileKind[] = ['LOGO', 'PRODUCT_IMAGE'];

const KEY_TYPE: Record<FileKind, string> = {
  AVATAR: 'avatar',
  LOGO: 'logo',
  PRODUCT_IMAGE: 'product-image',
  LAB_PROTOCOL: 'lab-protocol',
  QR: 'qr',
  REPORT: 'report',
};

export interface VariantMeta {
  key: string;
  sha256: string;
  size: number;
}

export interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface PreparedFile {
  row: Insertable<Files> & { id: string; created_at: Date };
  objects: StoredObject[];
}

/** The contract's `FileRef`: original MIME/size/name; public URL for public kinds, a signed one otherwise. */
export interface FileRef {
  id: string;
  url: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

export const objectKey = (kind: FileKind, id: string, createdAt: Date, variant: string): string =>
  `${KEY_TYPE[kind]}/${createdAt.getUTCFullYear()}/${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}/${id}/${variant}`;

export const fileUrl = (fileUrls: FileUrls, kind: string, id: string): string =>
  (PUBLIC_KINDS as readonly string[]).includes(kind) ? publicFileUrl(id) : fileUrls.signed(id);

export function fileRef(
  fileUrls: FileUrls,
  row: Pick<FileRow, 'id' | 'kind' | 'mime' | 'size_bytes' | 'original_name'>,
): FileRef {
  return {
    id: row.id,
    url: fileUrl(fileUrls, row.kind, row.id),
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    originalName: row.original_name,
  };
}

/** Audit view of a files row (API names, the seed's auditView of `files`): every column but bookkeeping. */
export function fileAuditView(row: PreparedFile['row']): Record<string, unknown> {
  return {
    bucket: row.bucket,
    objectKey: row.object_key,
    originalName: row.original_name,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    variants: typeof row.variants === 'string' ? JSON.parse(row.variants) : (row.variants ?? {}),
    kind: row.kind,
    ownerId: row.owner_id ?? null,
  };
}

/**
 * Checks an upload against the allowed types (by signature) and builds the row and objects: raster images → the
 * original plus WebP 96/480; SVG → the sanitized document. 415 UNSUPPORTED_MEDIA_TYPE `{allowed}` for any other type,
 * a forged signature or an SVG that cannot be accepted.
 */
export async function prepareUpload(
  upload: UploadedFile,
  opts: {
    kind: FileKind;
    ownerId: string;
    bucket: string;
    allowed: readonly SniffedType[];
    /** Aborted when the client goes away: a queued SVG job is dropped (P18). */
    signal?: AbortSignal;
  },
): Promise<PreparedFile> {
  const unsupported = (reason?: string) =>
    new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', {
      params: { allowed: [...opts.allowed], ...(reason && { reason }) },
    });
  const mime = sniff(upload.bytes);
  if (mime === null || !opts.allowed.includes(mime)) throw unsupported();

  const id = randomUUID();
  const createdAt = new Date();
  const key = (variant: string) => objectKey(opts.kind, id, createdAt, variant);
  let original = upload.bytes;
  const objects: StoredObject[] = [];
  const variants: Record<string, VariantMeta> = {};

  if ((RASTER_TYPES as readonly string[]).includes(mime)) {
    const out = await rasterVariants(upload.bytes, mime as (typeof RASTER_TYPES)[number]);
    if (!out) throw unsupported();
    for (const [size, v] of Object.entries(out)) {
      variants[size] = { key: key(size), sha256: v.sha256, size: v.size };
      objects.push({ key: key(size), body: v.body, contentType: 'image/webp' });
    }
  } else if (mime === 'image/svg+xml') {
    const clean = await sanitizeSvg(upload.bytes, opts.signal);
    if (!clean.ok) throw unsupported(clean.reason === 'too-complex' ? 'svg-too-complex' : undefined);
    original = Buffer.from(clean.svg, 'utf8');
  }
  objects.unshift({ key: key('original'), body: original, contentType: mime });

  return {
    row: {
      id,
      bucket: opts.bucket,
      object_key: key('original'),
      original_name: upload.filename,
      mime,
      size_bytes: original.length,
      sha256: sha256hex(original),
      variants: JSON.stringify(variants),
      kind: opts.kind,
      owner_id: opts.ownerId,
      created_at: createdAt,
    },
    objects,
  };
}

/** Writes the objects to MinIO (before the row is committed: a row never points at a missing object). */
export async function storeObjects(s3: S3, file: PreparedFile): Promise<void> {
  await Promise.all(file.objects.map((o) => s3.put(o.key, o.body, o.contentType)));
}

/** Inserts the file row; `created_at` = the transaction's instant (P43; the object key keeps the prepare-time month). */
export async function insertFile(tx: Transaction<DB>, file: PreparedFile): Promise<void> {
  file.row.created_at = await txNow(tx);
  await tx.insertInto('files').values(file.row).execute();
}

/** Soft-deletes a file (its URLs answer 404 from now on); null — nothing to do. */
export async function softDeleteFile(tx: Transaction<DB>, id: string | null, now: Date): Promise<boolean> {
  if (id === null) return false;
  const r = await tx
    .updateTable('files')
    .set({ deleted_at: now })
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}
