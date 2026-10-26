<?php

namespace App\Http\Controllers\Sse;

use App\Http\ExactHeaders;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Infrastructure\Redis\SharedRedis;
use App\Security\Jwt;
use App\Sse\ClientSocketIo;
use App\Sse\PgStreamStore;
use App\Sse\RespSubscriber;
use App\Sse\Stream;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * GET /events/stream — streamEvents (contracts/openapi/paths/events.yaml; Express notifications/routes.ts). Served by
 * FrankenPHP's classic threads (public/sse.php, docker/Caddyfile), never an Octane worker: a stream lives up to the
 * token's 15 minutes.
 *
 * The `access_token` query parameter authenticates (EventSource cannot send headers; Authorization is not used): an
 * invalid, expired or repeated one → 401 problem before the stream; then the `user` rate limit (R30) — x-roles ANY.
 * `Last-Event-ID` wins over `lastEventId` (present at all, it decides); a value that is not a sequence number
 * (`^\d{1,18}$`) is treated as absent (the operation declares no 400). Headers: `Content-Type: text/event-stream;
 * charset=utf-8`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (the gateway must not
 * buffer), then App\Sse\Stream takes over.
 */
final class StreamController
{
    public function open(Request $request): Response
    {
        $q = QueryReader::of($request);
        $token = $q->string('access_token');
        $principal = $token !== null && $token !== '' ? Jwt::tryVerify($token) : null;
        if ($principal === null) {
            throw new Problem(401, ProblemCode::UNAUTHORIZED);
        }
        RateLimiter::hit('user', $principal->userId);
        $header = $request->headers->all('last-event-id');
        $raw = $header !== [] ? implode(', ', $header) : $q->string('lastEventId');
        $lastSeq = $raw !== null && preg_match('/^\d{1,18}$/D', $raw) === 1 ? $raw : null;

        $response = new StreamedResponse(function () use ($request, $principal, $lastSeq): void {
            ignore_user_abort(true);
            set_time_limit(0);
            while (ob_get_level() > 0) {
                ob_end_flush();
            }
            // No flush() before the first frame: FrankenPHP hands PHP's headers to Go only with the first output — a
            // bare flush would commit a 200 without them (measured: no Content-Type, no X-Backend). The headers go
            // out with the first frame, which follows the connect sequence at once.
            // Only the stream's own Redis connection stays open (the rate limit's is closed).
            app('redis')->purge();
            $stream = new Stream(
                $principal->userId,
                $principal->exp,
                $lastSeq,
                RespSubscriber::fromConfig(),
                new PgStreamStore,
                new ClientSocketIo($request),
                function (): array {
                    try {
                        $v = SharedRedis::client()->mget([Stream::GEN_KEY, Stream::LOST_AT_KEY]);
                    } finally {
                        app('redis')->purge();
                    }

                    return ['gen' => (int) ($v[0] ?? 0), 'lostAt' => is_string($v[1] ?? null) ? $v[1] : null];
                },
            );
            $stream->run();
        }, 200);
        $response->headers = new ExactHeaders([
            'Content-Type' => 'text/event-stream; charset=utf-8',
            'Cache-Control' => 'no-cache',
            'Connection' => 'keep-alive',
            'X-Accel-Buffering' => 'no',
        ]);

        return $response;
    }
}
