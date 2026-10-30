<?php

namespace App\Infrastructure\Xlsx;

/**
 * ZIP archives read in memory with hard limits (P23, P24; Express infra/zip.ts), framework-free (the XLSX sandbox child
 * uses it). The central directory is the source of truth: at most 64 entries, a declared uncompressed size of at most
 * 16 MiB per entry and 32 MiB in all. `directory()` checks only that (the request thread's stage 1); `open()` then
 * inflates EVERY entry in directory order — read by the import or not — in small input steps capped at its declared
 * size + 1 byte, so the bytes produced are bounded too: more than declared → tooLarge; fewer, a truncated stream or a
 * CRC-32 mismatch → invalid. Only `stored` (0) and `deflate` (8) are read; encrypted entries, ZIP64 and multi-disk
 * archives are refused (invalid).
 */
final class Zip
{
    public const MAX_ENTRIES = 64;

    public const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

    public const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

    private const EOCD = 0x06054B50;

    private const CENTRAL = 0x02014B50;

    private const LOCAL = 0x04034B50;

    /** Input bytes fed to the inflater per step: deflate expands at most ~1032:1, so one step yields ≤ ~1 MiB. */
    private const INFLATE_STEP = 1024;

    /**
     * The central directory entries (names and declared sizes), limits checked; nothing is inflated.
     *
     * @return list<array{name: string, method: int, flags: int, crc: int, compressedSize: int, size: int, localOffset: int}>
     *
     * @throws ZipError
     */
    public static function directory(string $b): array
    {
        $len = strlen($b);
        $from = max(0, $len - 22 - 65535);
        $eocd = -1;
        for ($i = $len - 22; $i >= $from; $i--) {
            if ($b[$i] === "\x50" && self::u32($b, $i) === self::EOCD) {
                $eocd = $i;
                break;
            }
        }
        if ($eocd < 0) {
            throw new ZipError('invalid');
        }
        if (self::u16($b, $eocd + 4) !== 0 || self::u16($b, $eocd + 6) !== 0) {
            throw new ZipError('invalid');
        }
        $count = self::u16($b, $eocd + 10);
        if ($count === 0xFFFF) {
            throw new ZipError('invalid'); // ZIP64
        }
        if ($count > self::MAX_ENTRIES) {
            throw new ZipError('tooLarge');
        }
        $p = self::u32($b, $eocd + 16);
        $out = [];
        $total = 0;
        for ($k = 0; $k < $count; $k++) {
            if ($p + 46 > $len || self::u32($b, $p) !== self::CENTRAL) {
                throw new ZipError('invalid');
            }
            $nameLen = self::u16($b, $p + 28);
            $extra = self::u16($b, $p + 30);
            $comment = self::u16($b, $p + 32);
            if ($p + 46 + $nameLen > $len) {
                throw new ZipError('invalid');
            }
            $e = [
                'name' => substr($b, $p + 46, $nameLen),
                'method' => self::u16($b, $p + 10),
                'flags' => self::u16($b, $p + 8),
                'crc' => self::u32($b, $p + 16),
                'compressedSize' => self::u32($b, $p + 20),
                'size' => self::u32($b, $p + 24),
                'localOffset' => self::u32($b, $p + 42),
            ];
            if ($e['size'] === 0xFFFFFFFF || $e['compressedSize'] === 0xFFFFFFFF) {
                throw new ZipError('invalid'); // ZIP64
            }
            if ($e['size'] > self::MAX_ENTRY_BYTES) {
                throw new ZipError('tooLarge');
            }
            $total += $e['size'];
            if ($total > self::MAX_TOTAL_BYTES) {
                throw new ZipError('tooLarge');
            }
            $out[] = $e;
            $p += 46 + $nameLen + $extra + $comment;
        }

        return $out;
    }

    /**
     * Inflates and checks every entry; the parts by name (a repeated name keeps its first entry).
     *
     * @throws ZipError
     */
    public static function open(string $b): ZipIndex
    {
        $parts = [];
        $len = strlen($b);
        foreach (self::directory($b) as $e) {
            if (($e['flags'] & 0x1) !== 0) {
                throw new ZipError('invalid'); // encrypted
            }
            $p = $e['localOffset'];
            if ($p + 30 > $len || self::u32($b, $p) !== self::LOCAL) {
                throw new ZipError('invalid');
            }
            $start = $p + 30 + self::u16($b, $p + 26) + self::u16($b, $p + 28);
            $end = $start + $e['compressedSize'];
            if ($end > $len) {
                throw new ZipError('invalid');
            }
            $data = match ($e['method']) {
                0 => substr($b, $start, $e['compressedSize']),
                8 => self::inflate($b, $start, $e['compressedSize'], $e['size']),
                default => throw new ZipError('invalid'),
            };
            if (strlen($data) > $e['size']) {
                throw new ZipError('tooLarge');
            }
            if (strlen($data) !== $e['size'] || crc32($data) !== $e['crc']) {
                throw new ZipError('invalid');
            }
            $parts[$e['name']] ??= $data;
        }

        return new ZipIndex($parts);
    }

    /** Raw deflate of $length bytes at $offset, never producing more than $declared + 1 bytes. */
    private static function inflate(string $b, int $offset, int $length, int $declared): string
    {
        $ctx = inflate_init(ZLIB_ENCODING_RAW);
        if ($ctx === false) {
            throw new ZipError('invalid');
        }
        $out = '';
        $cap = $declared + 1;
        for ($i = 0; $i < $length; $i += self::INFLATE_STEP) {
            $last = $i + self::INFLATE_STEP >= $length;
            $chunk = @inflate_add($ctx, substr($b, $offset + $i, min(self::INFLATE_STEP, $length - $i)), $last ? ZLIB_FINISH : ZLIB_SYNC_FLUSH);
            if ($chunk === false) {
                throw new ZipError('invalid');
            }
            $out .= $chunk;
            if (strlen($out) >= $cap) {
                throw new ZipError('tooLarge');
            }
            if (inflate_get_status($ctx) === ZLIB_STREAM_END) {
                return $out;
            }
        }
        if ($length === 0 || inflate_get_status($ctx) !== ZLIB_STREAM_END) {
            throw new ZipError('invalid'); // truncated stream
        }

        return $out;
    }

    private static function u16(string $b, int $p): int
    {
        if ($p < 0 || $p + 2 > strlen($b)) {
            throw new ZipError('invalid');
        }

        return ord($b[$p]) | (ord($b[$p + 1]) << 8);
    }

    private static function u32(string $b, int $p): int
    {
        if ($p < 0 || $p + 4 > strlen($b)) {
            throw new ZipError('invalid');
        }

        return ord($b[$p]) | (ord($b[$p + 1]) << 8) | (ord($b[$p + 2]) << 16) | (ord($b[$p + 3]) << 24);
    }
}
