<?php

namespace App\Http\Middleware;

use App\Http\Problem\Problem;
use App\Http\Problem\Renderer;
use Closure;
use Illuminate\Http\Request;
use JsonException;
use stdClass;
use Symfony\Component\HttpFoundation\Response;

/**
 * The JSON body of every request (L8; Express `express.json`, strict), before routing — so a malformed body is 400 on
 * any contract operation, implemented or not:
 * - `application/json` or `application/*+json`; read from php://input with a cap of 12 MiB + 1 byte. A declared
 *   Content-Length over 12 582 912 bytes is refused before reading; either way 413 FILE_TOO_LARGE
 *   `params.maxBytes` 12582912 with `Connection: close`;
 * - strict: the text must be a JSON object or array (after leading white space), else 400 VALIDATION
 *   `errors._root [validation.invalid]` (P7) — as is a charset other than UTF-8 or a Content-Encoding;
 * - objects decode to stdClass (`{}` stays an object), invalid UTF-8 inside strings becomes U+FFFD (as Node's
 *   decoder does); an empty body is `{}`.
 * The decoded value is the request attribute `json`, the raw bytes `rawBody` (the Idempotency-Key fingerprint, R48).
 */
final class JsonBody
{
    public const ATTR_JSON = 'json';

    public const ATTR_RAW = 'rawBody';

    public function handle(Request $request, Closure $next): Response
    {
        // Only JSON has this limit (review I5): uploads keep their operation's own (multipart reader, Tasks 3–5).
        if (! self::isJson((string) $request->headers->get('Content-Type', ''))) {
            return $next($request);
        }
        $length = $request->headers->get('Content-Length');
        if (is_string($length) && ctype_digit($length) && (strlen($length) > 9 || (int) $length > Renderer::MAX_JSON_BYTES)) {
            throw self::tooLarge();
        }
        $raw = self::read($request);
        $request->attributes->set(self::ATTR_RAW, $raw);
        $request->attributes->set(self::ATTR_JSON, self::parse($request, $raw));

        return $next($request);
    }

    public static function isJson(string $contentType): bool
    {
        $mime = strtolower(trim(explode(';', $contentType, 2)[0]));
        if ($mime === 'application/json') {
            return true;
        }

        return str_starts_with($mime, 'application/') && str_ends_with($mime, '+json') && strlen($mime) > 17;
    }

    private static function read(Request $request): string
    {
        $stream = $request->getContent(true);
        $raw = '';
        while (! feof($stream)) {
            $chunk = fread($stream, 65536);
            if ($chunk === false) {
                break;
            }
            $raw .= $chunk;
            if (strlen($raw) > Renderer::MAX_JSON_BYTES) {
                throw self::tooLarge();
            }
        }

        return $raw;
    }

    private static function parse(Request $request, string $raw): mixed
    {
        $invalid = Problem::validation(['_root' => ['validation.invalid']]);
        $encoding = strtolower(trim((string) $request->headers->get('Content-Encoding', 'identity')));
        if ($encoding !== 'identity' && $encoding !== '') {
            throw $invalid;
        }
        foreach (array_slice(explode(';', (string) $request->headers->get('Content-Type', '')), 1) as $param) {
            [$key, $value] = array_pad(explode('=', $param, 2), 2, '');
            if (strtolower(trim($key)) === 'charset'
                && ! in_array(strtolower(trim(trim($value), '"')), ['utf-8', 'utf8'], true)) {
                throw $invalid;
            }
        }
        if ($raw === '') {
            return new stdClass;
        }
        $first = ltrim($raw, " \t\n\r")[0] ?? '';
        if ($first !== '{' && $first !== '[') {
            throw $invalid;
        }
        try {
            return json_decode($raw, false, 512, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
        } catch (JsonException) {
            throw $invalid;
        }
    }

    private static function tooLarge(): Problem
    {
        $p = Renderer::tooLarge();

        return new Problem($p->status, $p->problemCode, params: $p->params, headers: ['Connection' => 'close']);
    }
}
