<?php

namespace App\Infrastructure\Dadata;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * DaData "findById/party" (FR-IAM-01, spec 8.9; Express infra/dadata.ts): the organization behind an INN. Never blocks
 * registration: no API key → `unavailable` without a call; up to 3 attempts of DADATA_TIMEOUT_MS (3 s) each with
 * back-off 200/400 ms; a 4xx (bad key, quota) is not retried → `unavailable`; a network error, timeout or 5xx after
 * 3 attempts → `unavailable`. No suggestion, or one without a name → `notFound`. The caller holds no DB slot (P61).
 */
final class Dadata
{
    /** @param  null|callable(string): array{status: int, body: mixed}  $post  test seam: one HTTP attempt */
    public static function findParty(string $inn, ?callable $post = null, int $backoffMs = 200): DadataResult
    {
        $key = config('agrotrace.dadata.key');
        if (! is_string($key) || $key === '') {
            return DadataResult::unavailable();
        }
        $post ??= fn (string $inn): array => self::post($key, $inn);
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            try {
                ['status' => $status, 'body' => $body] = $post($inn);
                if ($status >= 400 && $status < 500) {
                    Log::warning('dadata rejected the request', ['status' => $status]);

                    return DadataResult::unavailable();
                }
                if ($status < 200 || $status >= 300) {
                    throw new \RuntimeException("dadata status {$status}");
                }

                return self::fromBody($body);
            } catch (Throwable $e) {
                Log::warning('dadata unavailable', ['err' => $e->getMessage(), 'attempt' => $attempt]);
                if ($attempt < 3) {
                    usleep($backoffMs * 1000 * 2 ** ($attempt - 1));
                }
            }
        }

        return DadataResult::unavailable();
    }

    /** @throws \RuntimeException for a `null` body (Express: reading `null.suggestions` throws → retried) */
    public static function fromBody(mixed $body): DadataResult
    {
        if ($body === null) {
            throw new \RuntimeException('dadata answered null');
        }
        $s = is_array($body) ? ($body['suggestions'][0] ?? null) : null;
        if (! is_array($s)) {
            return DadataResult::notFound();
        }
        $pick = fn (mixed $v): ?string => is_string($v) && $v !== '' ? $v : null;
        $name = $pick($s['data']['name']['short_with_opf'] ?? null)
            ?? $pick($s['value'] ?? null)
            ?? $pick($s['data']['name']['full_with_opf'] ?? null);
        if ($name === null) {
            return DadataResult::notFound();
        }
        $address = $s['data']['address']['value'] ?? null;

        return DadataResult::found(
            mb_substr($name, 0, 255),
            is_string($address) ? mb_substr($address, 0, 500) : null,
        );
    }

    /** @return array{status: int, body: mixed} */
    private static function post(string $key, string $inn): array
    {
        $timeout = max(0.1, (int) config('agrotrace.dadata.timeout_ms', 3000) / 1000);
        $res = Http::withHeaders(['Authorization' => "Token {$key}", 'Accept' => 'application/json'])
            ->timeout($timeout)->connectTimeout($timeout)
            ->asJson()
            ->post((string) config('agrotrace.dadata.url'), ['query' => $inn, 'count' => 1]);

        // As Express's res.json(): a 2xx body that is no JSON throws (retried, then unavailable), not notFound (M4).
        $ok = $res->status() >= 200 && $res->status() < 300;

        return ['status' => $res->status(), 'body' => $ok ? json_decode($res->body(), true, 512, JSON_THROW_ON_ERROR) : null];
    }
}
