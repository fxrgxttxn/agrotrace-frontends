<?php

namespace App\Actions\Public;

use App\Actions\Batches\Lifecycle;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Validation\Schemas\ComplaintSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Infrastructure\Redis\SharedRedis;
use App\Security\Altcha;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;

/**
 * The public part (contracts/openapi/paths/public.yaml; FR-PUB-01…03, R30, R82, P9, P10; Express public/service.ts line
 * by line), no authentication:
 *
 * - getPublicBatch — the page bytes (PublicBatchBuilder): a hit of `pub:batch:{publicCode}` is sent byte for byte,
 *   never parsed or re-serialized; a miss builds, stores (`SET EX 300`), re-reads the batch's version and deletes the
 *   key if it changed meanwhile (M10: no stale safety status after a parallel recall or block).
 * - getCaptchaChallenge — an ALTCHA challenge (Security\Altcha); the controller adds `Cache-Control: no-store`.
 * - createPublicComplaint — order: the `complaint-ip` limit (every request counts, RATE_LIMIT_OVERRIDES honoured) →
 *   the publicCode pattern and the body in one 400 → the ALTCHA solution (invalid, expired or already used → 400
 *   CAPTCHA_FAILED) → the batch (404; a solution is not used up by a 404) → the solution marked used
 *   (`altcha-used:{signature}` SET NX EX 600; a parallel replay loses here) → the complaint NEW, its audit row (no
 *   actor, the client's ip), COMPLAINT to the inspectors in the outbox.
 *
 * P61: Redis and the proof-of-work check run with no DB slot held — the slot is given back after the batch read,
 * before the SET NX, and taken again for the transaction.
 */
final class PublicActions
{
    public const PUBLIC_CODE = '/\AAT-[0-9]{4}-[0-9]{6,}\z/';

    private static function notFound(): Problem
    {
        return new Problem(404, ProblemCode::NOT_FOUND);
    }

    private static function captchaFailed(): Problem
    {
        return new Problem(400, ProblemCode::CAPTCHA_FAILED);
    }

    private static function key(): string
    {
        return Altcha::key((string) config('agrotrace.jwt_secret'));
    }

    private static function nowMs(): int
    {
        return (int) (microtime(true) * 1000);
    }

    /** getPublicBatch — the page bytes (from the cache or freshly built and stored). */
    public static function page(string $code): string
    {
        if (preg_match(self::PUBLIC_CODE, $code) !== 1) {
            throw Problem::validation(['publicCode' => ['validation.pattern']]);
        }

        return PublicBatchBuilder::cached($code) ?? throw self::notFound();
    }

    /** @return array<string, mixed> */
    public static function captcha(): array
    {
        return Altcha::challenge(self::key(), self::nowMs());
    }

    /**
     * createPublicComplaint (see the class comment for the order).
     *
     * @return array{id: string, createdAt: string}
     */
    public static function complain(?string $ip, string $code, mixed $body): array
    {
        RateLimiter::hit('complaint-ip', $ip ?? 'unknown');
        $codeErrors = preg_match(self::PUBLIC_CODE, $code) === 1 ? [] : ['publicCode' => ['validation.pattern']];
        $input = ComplaintSchemas::parsePublic($body, $codeErrors);
        $signature = Altcha::verify(self::key(), $input['altcha'], self::nowMs());
        $redis = SharedRedis::client();
        $usedKey = "altcha-used:{$signature}";
        if ($signature === null || (int) $redis->exists($usedKey) === 1) {
            throw self::captchaFailed();
        }
        $b = DB::selectOne('SELECT b.id, b.public_code, p.name AS product_name
              FROM batches b JOIN products p ON p.id = b.product_id WHERE b.public_code = ? AND b.deleted_at IS NULL', [$code]);
        if ($b === null) {
            throw self::notFound();
        }
        SlotHolder::release();
        if ($redis->set($usedKey, '1', ['NX', 'EX' => Altcha::TTL_SEC]) !== true) {
            throw self::captchaFailed();
        }
        $contact = $input['contact'] ?? null;

        return Tx::run(function () use ($ip, $b, $input, $contact): array {
            $row = DB::selectOne("INSERT INTO complaints (batch_id, text, contact, status, ip) VALUES (?, ?, ?, 'NEW', ?::inet)
                 RETURNING id, created_at::text AS created_at", [$b->id, $input['text'], $contact, $ip]);
            AuditLog::write(null, 'createPublicComplaint', 'complaint', $row->id, AuditLog::diff(null, [
                'batchId' => $b->id,
                'text' => $input['text'],
                'contact' => $contact,
                'status' => 'NEW',
            ]));
            Lifecycle::notify('COMPLAINT', ['roles' => ['INSPECTOR']], [
                'complaintId' => $row->id,
                'batchId' => $b->id,
                'publicCode' => $b->public_code,
                'productName' => $b->product_name,
            ]);

            return ['id' => $row->id, 'createdAt' => (string) Iso::fromPg($row->created_at)];
        });
    }
}
