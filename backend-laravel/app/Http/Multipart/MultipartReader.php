<?php

namespace App\Http\Multipart;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Problem\Renderer;
use App\Http\Validation\Z\StringS;
use Illuminate\Http\Request;

/**
 * `multipart/form-data` uploads with exactly one file part `file` (contract ImageUpload / LogoUpload / ProtocolUpload /
 * ImportUpload; Express http/multipart.ts over busboy), parsed by hand from php://input (L8: PHP would silently ignore
 * a malformed body or a second `file`). The limit is inclusive (size ≤ maxBytes is accepted); past it the rest of the
 * body is still read so the client receives the 413 — up to the gateway's 12 MiB; a longer body is answered 413 at
 * once with `Connection: close`.
 *
 * Problems, in this order (P14): 400 VALIDATION for the form — `file: [validation.required]` (no file part, an empty
 * one, not a multipart body at all), `validation.duplicate` (a second `file`), `<name>: [validation.unknownField]`
 * (any other part), `file: [validation.maxLength]` (a base name over 255 code points, P20), `_root:
 * [validation.invalid]` (a malformed body, more than 20 parts or fields) — then 413 FILE_TOO_LARGE `{maxBytes}`.
 * The name is the base name: every `/` or `\` path segment is dropped (P17); quoted-string escapes are undone, `%22`
 * stays as sent (form rules).
 */
final class MultipartReader
{
    private const FIELD = 'file';

    private const MAX_PARTS = 20;

    private const MAX_FIELDS = 20;

    private const MAX_HEADER_PAIRS = 50;

    public static function read(Request $request, int $maxBytes): Upload
    {
        $type = strtolower((string) $request->headers->get('Content-Type', ''));
        if (! str_starts_with($type, 'multipart/form-data')) {
            throw Problem::validation([self::FIELD => ['validation.required']]);
        }
        $boundary = self::boundary((string) $request->headers->get('Content-Type'));
        if ($boundary === null) {
            throw Problem::validation(['_root' => ['validation.invalid']]);
        }
        $length = $request->headers->get('Content-Length');
        if (is_string($length) && ctype_digit($length) && (strlen($length) > 9 || (int) $length > Renderer::MAX_JSON_BYTES)) {
            throw self::tooLarge($maxBytes, true);
        }
        $body = self::readBody($request, $maxBytes);

        return self::parse($body, $boundary, $maxBytes);
    }

    /** The parse of a complete body (unit-testable). */
    public static function parse(string $body, string $boundary, int $maxBytes): Upload
    {
        $errors = [];
        $addError = function (string $field, string $key) use (&$errors): void {
            if (! in_array($key, $errors[$field] ?? [], true)) {
                $errors[$field][] = $key;
            }
        };
        $file = null;
        $tooLarge = false;
        $delimiter = '--'.$boundary;
        $pos = strpos($body, $delimiter);
        $malformed = $pos === false;
        $parts = 0;
        $fields = 0;
        while (! $malformed) {
            $pos += strlen($delimiter);
            if (substr($body, $pos, 2) === '--') {
                break; // the close delimiter
            }
            // Transport padding (spaces/tabs) may follow a delimiter before its CRLF.
            while ($pos < strlen($body) && ($body[$pos] === ' ' || $body[$pos] === "\t")) {
                $pos++;
            }
            if (substr($body, $pos, 2) !== "\r\n") {
                $malformed = true;
                break;
            }
            $pos += 2;
            $headerEnd = strpos($body, "\r\n\r\n", $pos);
            $next = strpos($body, "\r\n".$delimiter, $pos);
            if ($headerEnd === false || $next === false || $headerEnd > $next) {
                $malformed = true;
                break;
            }
            $headers = self::headers(substr($body, $pos, $headerEnd - $pos));
            if ($headers === null) {
                $malformed = true;
                break;
            }
            $content = substr($body, $headerEnd + 4, $next - $headerEnd - 4);
            $pos = $next + 2;
            $parts++;
            if ($parts > self::MAX_PARTS) {
                $addError('_root', 'validation.invalid');
                break;
            }
            $disposition = self::disposition($headers['content-disposition'] ?? '');
            if ($disposition === null || $disposition['name'] === null) {
                continue; // not form-data: busboy skips such a part
            }
            $name = self::utf8($disposition['name']);
            if ($disposition['filename'] === null) {
                $fields++;
                if ($fields > self::MAX_FIELDS) {
                    $addError('_root', 'validation.invalid');
                    break;
                }
                $addError($name, $name === self::FIELD ? 'validation.required' : 'validation.unknownField');

                continue;
            }
            if ($name !== self::FIELD) {
                $addError($name, 'validation.unknownField');

                continue;
            }
            if ($file !== null) {
                $addError(self::FIELD, 'validation.duplicate');

                continue;
            }
            $file = ['name' => self::utf8(self::baseName($disposition['filename'])), 'bytes' => strlen($content) > $maxBytes ? '' : $content];
            $tooLarge = strlen($content) > $maxBytes;
        }
        if ($malformed) {
            throw Problem::validation(['_root' => ['validation.invalid']]);
        }
        if ($file !== null && in_array('validation.required', $errors[self::FIELD] ?? [], true)) {
            // A text part named `file` next to a real file part: the text part is the extra one.
            $errors[self::FIELD] = array_values(array_filter($errors[self::FIELD], fn ($k) => $k !== 'validation.required'));
            $addError(self::FIELD, 'validation.duplicate');
        }
        if ($file === null || ($file['bytes'] === '' && ! $tooLarge)) {
            $addError(self::FIELD, 'validation.required');
        }
        if ($file !== null && StringS::codePoints($file['name']) > 255) {
            $addError(self::FIELD, 'validation.maxLength');
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }
        if ($tooLarge) {
            throw self::tooLarge($maxBytes, false);
        }

        return new Upload($file['bytes'], $file['name'], strlen($file['bytes']));
    }

    /** Invalid UTF-8 sequences become U+FFFD, as busboy's UTF-8 decoding of the header does. */
    public static function utf8(string $s): string
    {
        return htmlspecialchars_decode(htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'), ENT_QUOTES);
    }

    /** busboy's basename (preservePath off): after the last `/` or `\`; `.` and `..` become ''. */
    public static function baseName(string $filename): string
    {
        $segments = explode('/', strtr($filename, '\\', '/'));
        $base = (string) end($segments);

        return $base === '.' || $base === '..' ? '' : $base;
    }

    /** The whole body, at most 12 MiB (one byte more → 413 at once, the connection closed). */
    private static function readBody(Request $request, int $maxBytes): string
    {
        $stream = $request->getContent(true);
        $body = '';
        while (! feof($stream)) {
            $chunk = fread($stream, 65536);
            if ($chunk === false || $chunk === '') {
                if (feof($stream)) {
                    break;
                }
                if ($chunk === false) {
                    throw Problem::validation(['_root' => ['validation.invalid']]);
                }

                continue;
            }
            $body .= $chunk;
            if (strlen($body) > Renderer::MAX_JSON_BYTES) {
                throw self::tooLarge($maxBytes, true);
            }
        }

        return $body;
    }

    private static function tooLarge(int $maxBytes, bool $close): Problem
    {
        return new Problem(413, ProblemCode::FILE_TOO_LARGE, params: ['maxBytes' => $maxBytes],
            headers: $close ? ['Connection' => 'close'] : []);
    }

    /** The `boundary` parameter of a multipart Content-Type (RFC 2046: 1–70 characters), or null. */
    public static function boundary(string $contentType): ?string
    {
        foreach (self::params(substr($contentType, (int) strpos($contentType, ';'))) as $k => $v) {
            if ($k === 'boundary') {
                return $v !== '' && strlen($v) <= 70 ? $v : null;
            }
        }

        return null;
    }

    /** @return array<string, string>|null lower-case header names; null when a line is not a header */
    private static function headers(string $block): ?array
    {
        $out = [];
        $lines = explode("\r\n", $block);
        if (count($lines) > self::MAX_HEADER_PAIRS) {
            return null;
        }
        foreach ($lines as $line) {
            if ($line === '') {
                continue;
            }
            $colon = strpos($line, ':');
            if ($colon === false || $colon === 0) {
                return null;
            }
            $out[strtolower(trim(substr($line, 0, $colon)))] = trim(substr($line, $colon + 1));
        }

        return $out;
    }

    /** @return array{name: ?string, filename: ?string}|null null — not `form-data` */
    private static function disposition(string $value): ?array
    {
        $semi = strpos($value, ';');
        $type = strtolower(trim($semi === false ? $value : substr($value, 0, $semi)));
        if ($type !== 'form-data') {
            return null;
        }
        $params = self::params($semi === false ? '' : substr($value, $semi));
        $filename = $params['filename'] ?? null;
        if (isset($params['filename*'])) {
            $ext = self::extValue($params['filename*']);
            $filename = $ext ?? $filename;
        }

        return ['name' => $params['name'] ?? null, 'filename' => $filename];
    }

    /**
     * `; key=value; key="quoted \" value"` → [key => value] (keys lower-cased, quoted-string escapes undone).
     *
     * @return array<string, string>
     */
    private static function params(string $s): array
    {
        $out = [];
        $n = strlen($s);
        $i = 0;
        while ($i < $n) {
            while ($i < $n && ($s[$i] === ';' || $s[$i] === ' ' || $s[$i] === "\t")) {
                $i++;
            }
            $eq = strpos($s, '=', $i);
            if ($eq === false) {
                break;
            }
            $key = strtolower(trim(substr($s, $i, $eq - $i)));
            $i = $eq + 1;
            $value = '';
            if ($i < $n && $s[$i] === '"') {
                $i++;
                while ($i < $n && $s[$i] !== '"') {
                    if ($s[$i] === '\\' && $i + 1 < $n) {
                        $i++;
                    }
                    $value .= $s[$i];
                    $i++;
                }
                $i++; // the closing quote
                $semi = strpos($s, ';', $i);
                $i = $semi === false ? $n : $semi;
            } else {
                $semi = strpos($s, ';', $i);
                $value = trim($semi === false ? substr($s, $i) : substr($s, $i, $semi - $i));
                $i = $semi === false ? $n : $semi;
            }
            if ($key !== '' && ! array_key_exists($key, $out)) {
                $out[$key] = $value;
            }
        }

        return $out;
    }

    /** RFC 5987 `charset'lang'pct-encoded` (UTF-8 or ISO-8859-1), or null. */
    private static function extValue(string $v): ?string
    {
        $parts = explode("'", $v, 3);
        if (count($parts) !== 3) {
            return null;
        }
        $decoded = rawurldecode($parts[2]);
        $charset = strtolower($parts[0]);
        if ($charset === 'utf-8' || $charset === 'utf8') {
            return mb_check_encoding($decoded, 'UTF-8') ? $decoded : null;
        }
        if ($charset === 'iso-8859-1' || $charset === 'latin1') {
            return mb_convert_encoding($decoded, 'UTF-8', 'ISO-8859-1');
        }

        return null;
    }
}
