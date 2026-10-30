<?php

namespace App\Http\Idempotency;

use App\Support\Json;
use stdClass;
use Throwable;

/**
 * A stored record `{"fingerprint", "state", "status"?, "body"?}` as any backend writes it (shared Redis format, R53).
 * `body` stays the decoded JSON value (objects as stdClass), so a replay serializes it again as Express does.
 */
final class IdemRecord
{
    public function __construct(
        public readonly string $fingerprint,
        public readonly mixed $state,
        public readonly mixed $status = null,
        public readonly mixed $body = null,
    ) {}

    /** Express `JSON.parse` + `typeof d === 'object' && typeof d.fingerprint === 'string'`; anything else → null. */
    public static function fromJson(string $raw): ?self
    {
        try {
            $d = Json::decode($raw);
        } catch (Throwable) {
            return null;
        }
        if (! $d instanceof stdClass || ! is_string($d->fingerprint ?? null)) {
            return null;
        }

        return new self($d->fingerprint, $d->state ?? null, $d->status ?? null, $d->body ?? null);
    }

    public function done(): bool
    {
        return $this->state === 'done';
    }
}
