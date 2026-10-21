<?php

namespace App\Infrastructure\Files;

use App\Http\Multipart\Upload;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Responses;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Images\Images;
use App\Infrastructure\Storage\ObjectStore;
use App\Infrastructure\Svg\SvgSanitizer;
use App\Security\FileUrls;
use App\Support\Json;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use stdClass;

/**
 * Stored files (FR-FILE-01…05, spec 8.6, R34; Express modules/files/{service,download}.ts): the `files` row, its MinIO
 * objects and the contract's FileRef.
 * - Object keys `{type}/{yyyy}/{mm}/{fileId}/{variant}`: the upload under `original`, the WebP variants under `96` and
 *   `480`; `files.variants` = `{"96": {key, sha256, size}, "480": {…}}` (the seed's layout).
 * - An SVG logo is stored after sanitization — the sanitized document is the file, so the served bytes, their ETag and
 *   `FileRef.sizeBytes` agree.
 * - Objects are written before the row (a row never points at a missing object); the row in the operation's
 *   transaction with `created_at` = Tx::now() (P43).
 * - Downloads: ETag = `"sha256"` of the served bytes, If-None-Match weak/list/`*` → 304, Content-Disposition (R34),
 *   nosniff, CSP for SVG, the object read before any header is set.
 */
final class Files
{
    public const CACHE_PRIVATE = 'private, max-age=0, must-revalidate';

    public const CACHE_PUBLIC = 'public, max-age=86400';

    private const KEY_TYPE = [
        'AVATAR' => 'avatar', 'LOGO' => 'logo', 'PRODUCT_IMAGE' => 'product-image', 'LAB_PROTOCOL' => 'lab-protocol',
        'QR' => 'qr', 'REPORT' => 'report',
    ];

    private const EXTENSION = [
        'image/webp' => 'webp', 'image/svg+xml' => 'svg', 'image/png' => 'png', 'image/jpeg' => 'jpg',
        'application/pdf' => 'pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => 'xlsx',
    ];

    /**
     * Checks an upload against the allowed types (by signature) and builds the row and objects: raster images → the
     * original plus WebP 96/480; SVG → the sanitized document. 415 `{allowed}` otherwise. CPU-heavy: the caller holds
     * no DB slot (P61).
     *
     * @param  list<string>  $allowed
     * @param  null|callable(): bool  $clientGone  drops a queued SVG job of a client that went away (P18)
     */
    public static function prepare(Upload $upload, string $kind, string $ownerId, array $allowed, ?callable $clientGone = null): PreparedFile
    {
        $mime = Images::sniff($upload->bytes);
        if ($mime === null || ! in_array($mime, $allowed, true)) {
            throw new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE, params: ['allowed' => $allowed]);
        }
        $id = (string) Str::uuid();
        $month = gmdate('Y/m');
        $key = fn (string $variant) => self::KEY_TYPE[$kind]."/{$month}/{$id}/{$variant}";
        $original = $upload->bytes;
        $objects = [];
        $variants = new stdClass;
        if (in_array($mime, Images::RASTER, true)) {
            foreach (Images::variants($upload->bytes, $mime, $allowed) as $size => $v) {
                $variants->{(string) $size} = ['key' => $key((string) $size), 'sha256' => $v['sha256'], 'size' => $v['size']];
                $objects[] = ['key' => $key((string) $size), 'bytes' => $v['bytes'], 'mime' => 'image/webp'];
            }
        } elseif ($mime === 'image/svg+xml') {
            $original = SvgSanitizer::sanitize($upload->bytes, $allowed, $clientGone);
        }
        array_unshift($objects, ['key' => $key('original'), 'bytes' => $original, 'mime' => $mime]);

        return new PreparedFile([
            'id' => $id,
            'bucket' => app(ObjectStore::class)->bucket(),
            'object_key' => $key('original'),
            'original_name' => $upload->originalName,
            'mime' => $mime,
            'size_bytes' => strlen($original),
            'sha256' => hash('sha256', $original),
            'variants' => $variants,
            'kind' => $kind,
            'owner_id' => $ownerId,
        ], $objects);
    }

    /** Writes the objects to MinIO (no DB slot held: P61). */
    public static function store(PreparedFile $file): void
    {
        SlotHolder::release();
        $store = app(ObjectStore::class);
        foreach ($file->objects as $o) {
            $store->put($o['key'], $o['bytes'], $o['mime']);
        }
    }

    /** Inserts the row in the current transaction; `created_at` = the transaction's instant (P43). */
    public static function insert(PreparedFile $file): void
    {
        $file->row['created_at'] = Tx::now();
        $r = $file->row;
        DB::insert(
            'INSERT INTO files (id, bucket, object_key, original_name, mime, size_bytes, sha256, variants, kind, owner_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::timestamptz)',
            [$r['id'], $r['bucket'], $r['object_key'], $r['original_name'], $r['mime'], $r['size_bytes'], $r['sha256'],
                Json::encode($r['variants']), $r['kind'], $r['owner_id'], $r['created_at']],
        );
    }

    /** Soft-deletes a file (its URLs answer 404 from now on); false — nothing to do. */
    public static function softDelete(?string $id, string $now): bool
    {
        if ($id === null) {
            return false;
        }

        return DB::update('UPDATE files SET deleted_at = ?::timestamptz WHERE id = ? AND deleted_at IS NULL', [$now, $id]) > 0;
    }

    /**
     * The contract's FileRef: original MIME/size/name; a public URL for LOGO/PRODUCT_IMAGE, a signed one otherwise.
     *
     * @return array{id: string, url: string, mime: string, sizeBytes: int, originalName: string}
     */
    public static function ref(string $id, string $kind, string $mime, int|string $size, string $originalName): array
    {
        return ['id' => $id, 'url' => FileUrls::forKind($kind, $id), 'mime' => $mime, 'sizeBytes' => (int) $size, 'originalName' => $originalName];
    }

    /** @return array<string, mixed> the audit view of a files row (API names; every column but bookkeeping) */
    public static function auditView(PreparedFile $file): array
    {
        $r = $file->row;

        return [
            'bucket' => $r['bucket'],
            'objectKey' => $r['object_key'],
            'originalName' => $r['original_name'],
            'mime' => $r['mime'],
            'sizeBytes' => (int) $r['size_bytes'],
            'sha256' => $r['sha256'],
            'variants' => $r['variants'],
            'kind' => $r['kind'],
            'ownerId' => $r['owner_id'],
        ];
    }

    /** A live (not deleted) files row, or null. */
    public static function live(string $id): ?stdClass
    {
        return DB::selectOne('SELECT id, object_key, original_name, mime, size_bytes, sha256, variants::text AS variants, kind, owner_id
            FROM files WHERE id = ? AND deleted_at IS NULL', [$id]);
    }

    /**
     * Streams a stored file: the WebP variant (default 480) of a raster image, otherwise the stored file itself.
     *
     * @param  stdClass  $file  a files row with `variants` as JSON text
     */
    public static function send(Request $request, stdClass $file, int $variant, string $cacheControl, ?string $disposition = null): Response
    {
        $served = self::served($file, $variant);
        $etag = '"'.$served['sha256'].'"';
        if (self::ifNoneMatch($request->headers->get('If-None-Match'), $etag)) {
            return Responses::make('', 304, ['ETag' => $etag, 'Cache-Control' => $cacheControl]);
        }
        // Read before any header is set: a storage failure is still a clean problem response. No DB slot held (P61).
        SlotHolder::release();
        $body = app(ObjectStore::class)->get($served['key']);
        $headers = [
            'Content-Type' => $served['mime'],
            'Content-Length' => (string) strlen($body),
            'Content-Disposition' => $disposition ?? self::contentDisposition($file->original_name, self::EXTENSION[$served['mime']] ?? 'bin'),
            'ETag' => $etag,
            'Cache-Control' => $cacheControl,
            'X-Content-Type-Options' => 'nosniff',
        ];
        if ($served['mime'] === 'image/svg+xml') {
            // Defence in depth for an SVG opened directly (the document is sanitized anyway).
            $headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        }

        return Responses::make($request->getMethod() === 'HEAD' ? '' : $body, 200, $headers);
    }

    /** @return array{key: string, sha256: string, size: int, mime: string} */
    private static function served(stdClass $file, int $variant): array
    {
        $variants = Json::decode($file->variants ?? '{}');
        $v = $variants instanceof stdClass ? ($variants->{(string) $variant} ?? null) : null;
        if ($v instanceof stdClass) {
            return ['key' => $v->key, 'sha256' => $v->sha256, 'size' => (int) $v->size, 'mime' => 'image/webp'];
        }

        return ['key' => $file->object_key, 'sha256' => trim($file->sha256), 'size' => (int) $file->size_bytes, 'mime' => $file->mime];
    }

    /** RFC 9110 If-None-Match: weak comparison against any listed tag; `*` matches any current representation. */
    public static function ifNoneMatch(?string $header, string $etag): bool
    {
        if ($header === null || $header === '') {
            return false;
        }
        $bare = str_starts_with($etag, 'W/') ? substr($etag, 2) : $etag;
        foreach (explode(',', $header) as $t) {
            $t = trim($t);
            if ($t === '*' || (str_starts_with($t, 'W/') ? substr($t, 2) : $t) === $bare) {
                return true;
            }
        }

        return false;
    }

    /**
     * components.headers.ContentDisposition (R34): `inline; filename="<ascii>"; filename*=UTF-8''<pct>`, the name =
     * originalName without its last extension (a leading dot is no extension) + `.` + the served type's extension.
     */
    public static function contentDisposition(string $originalName, string $ext): string
    {
        $dot = strrpos($originalName, '.');
        $name = ($dot !== false && $dot > 0 ? substr($originalName, 0, $dot) : $originalName).'.'.$ext;
        $ascii = '';
        foreach (mb_str_split($name, 1, 'UTF-8') as $ch) {
            $cp = mb_ord($ch, 'UTF-8');
            $ascii .= $cp >= 0x20 && $cp <= 0x7E && $ch !== '"' && $ch !== '\\' ? $ch : '_';
        }
        $pct = '';
        $attr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~';
        for ($i = 0, $n = strlen($name); $i < $n; $i++) {
            $pct .= str_contains($attr, $name[$i]) ? $name[$i] : sprintf('%%%02X', ord($name[$i]));
        }

        return "inline; filename=\"{$ascii}\"; filename*=UTF-8''{$pct}";
    }
}
