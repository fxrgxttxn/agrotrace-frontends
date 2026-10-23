<?php

namespace App\Http\Middleware;

use App\Domain\Idempotency as IdempotencyRule;
use App\Http\Idempotency\IdemStore;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Responses;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Security\Auth;
use App\Support\Json;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * `Idempotency-Key` (BR-11, R48, R53; components/parameters.yaml#/IdempotencyKey; Express http/idempotency.ts) on the
 * operations with `x-idempotent: true` (routes/api.php attaches it from the contract): after `operation` (401,
 * x-roles), before the operation's own parameters, body and checks.
 *
 * - key missing or not `^[A-Za-z0-9_-]{8,128}$` (Domain\Idempotency::decision) → 400 INVALID_IDEMPOTENCY_KEY;
 * - Redis key `idem:{userId}:{key}`; fingerprint = sha256 hex of `"{METHOD} {path}\n"` + the raw body bytes (the
 *   request target's path as sent, without the query string; the bytes JsonBody kept, before any decoding);
 * - `SET NX EX 60` of the pending mark; when the key exists: another fingerprint → 409 IDEMPOTENCY_KEY_REUSED; same
 *   and not done → 409 IDEMPOTENCY_KEY_IN_PROGRESS + `Retry-After: 1`; same and done → the stored status and body
 *   again (serialized anew, `application/json`, `Idempotent-Replayed: true`); a key that expired between the SET and
 *   the GET → one more claim;
 * - the owner settles before its response leaves this middleware: 2xx → the Lua compare-and-set stores the decoded
 *   body (objects kept) for 86400 s; any other answer (a problem, a crash rendered as 500) → the Lua compare-and-delete.
 *   The database connection and its DbSlots slot are given back first (P61): the request has finished its SQL.
 * - A client that goes away decides nothing: there is no terminate/abort hook here — the owner runs to its answer and
 *   settles; an owner that never answers leaves the pending mark to its TTL.
 */
final class Idempotency
{
    public const HEADER = 'Idempotency-Key';

    public function __construct(private readonly IdemStore $store) {}

    public function handle(Request $request, Closure $next): Response
    {
        $principal = Auth::principal();
        // Node joins repeated headers of this name with ", " — then the key is invalid, as it is here.
        $key = implode(', ', array_map('strval', $request->headers->all(strtolower(self::HEADER))));
        $fingerprint = self::fingerprint($request);
        if (IdempotencyRule::decision(['key' => $key, 'stored' => null, 'fingerprint' => $fingerprint])['decision'] === 'INVALID_KEY') {
            throw new Problem(400, ProblemCode::INVALID_IDEMPOTENCY_KEY);
        }
        $redisKey = "idem:{$principal->userId}:{$key}";
        for ($attempt = 0; $attempt < 2; $attempt++) {
            if ($this->store->claim($redisKey, $fingerprint)) {
                return $this->own($request, $next, $redisKey, $fingerprint);
            }
            $stored = $this->store->get($redisKey);
            if ($stored === null) {
                continue; // expired between SET NX and GET — claim again
            }
            $decision = IdempotencyRule::decision(['key' => $key, 'stored' => ['fingerprint' => $stored->fingerprint], 'fingerprint' => $fingerprint]);
            if ($decision['decision'] === 'CONFLICT') {
                throw new Problem(409, ProblemCode::IDEMPOTENCY_KEY_REUSED);
            }
            if (! $stored->done()) {
                throw self::inProgress();
            }

            return Responses::make(Json::encode($stored->body), self::replayStatus($stored->status), [
                'Content-Type' => 'application/json; charset=utf-8',
                'Idempotent-Replayed' => 'true',
            ]);
        }

        throw self::inProgress();
    }

    /** sha256 hex of `"{METHOD} {path}\n"` followed by the raw request body bytes. */
    public static function fingerprint(Request $request): string
    {
        $target = (string) $request->server->get('REQUEST_URI', '');
        $path = explode('?', $target, 2)[0];
        $raw = $request->attributes->get(JsonBody::ATTR_RAW);

        return hash('sha256', $request->getRealMethod().' '.$path."\n".(is_string($raw) ? $raw : ''));
    }

    private function own(Request $request, Closure $next, string $key, string $fingerprint): Response
    {
        try {
            $response = $next($request);
        } catch (Throwable $e) {
            $this->settle($key, $fingerprint, 500, null);

            throw $e;
        }
        $status = $response->getStatusCode();
        $body = null;
        if ($status >= 200 && $status < 300) {
            $content = $response->getContent();
            if (is_string($content) && $content !== '') {
                try {
                    $body = Json::decode($content);
                } catch (Throwable) {
                    $body = null;
                }
            }
        }
        $this->settle($key, $fingerprint, $status, $body);

        return $response;
    }

    private function settle(string $key, string $fingerprint, int $status, mixed $body): void
    {
        // The slot release has its own try: a throw there must not leave the key pending until its TTL.
        try {
            if (! Tx::active()) {
                SlotHolder::release();
            }
        } catch (Throwable $e) {
            Log::warning('db slot not released before the idempotency settle', ['err' => $e->getMessage()]);
        }
        try {
            if ($status >= 200 && $status < 300) {
                $this->store->complete($key, $fingerprint, $status, $body);
            } else {
                $this->store->release($key, $fingerprint);
            }
        } catch (Throwable $e) {
            Log::warning('idempotency record not settled', ['err' => $e->getMessage()]);
        }
    }

    /** Express `res.status(stored.status ?? 200)`: a record without a status replays as 200. */
    private static function replayStatus(mixed $status): int
    {
        if ($status === null) {
            return 200;
        }
        if (is_int($status) && $status >= 100 && $status <= 599) {
            return $status;
        }

        throw new RuntimeException('idempotency record with an invalid status');
    }

    private static function inProgress(): Problem
    {
        return new Problem(409, ProblemCode::IDEMPOTENCY_KEY_IN_PROGRESS, headers: ['Retry-After' => '1']);
    }
}
