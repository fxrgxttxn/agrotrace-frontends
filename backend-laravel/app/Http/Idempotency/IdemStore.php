<?php

namespace App\Http\Idempotency;

/**
 * The storage operations of the `Idempotency-Key` protocol (R48; Express http/idempotency.ts `IdemStore`): Redis in
 * the application (RedisIdemStore), a map in Pest (tests/Support/MemoryIdemStore).
 */
interface IdemStore
{
    public const PENDING_TTL_SEC = 60;

    public const DONE_TTL_SEC = 86400;

    /** `SET NX EX PENDING_TTL_SEC` of `{"fingerprint", "state": "pending"}`; false — the key exists. */
    public function claim(string $key, string $fingerprint): bool;

    /** The record, or null when there is none or it is not a JSON object with a string `fingerprint`. */
    public function get(string $key): ?IdemRecord;

    /** Compare-and-set to `done` (only the own pending record); false — not stored. $body — the decoded JSON body. */
    public function complete(string $key, string $fingerprint, int $status, mixed $body): bool;

    /** Compare-and-delete (only the own pending record). */
    public function release(string $key, string $fingerprint): bool;
}
